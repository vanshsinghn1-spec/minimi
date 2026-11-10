// ---------------------------------------------------------------------------
// Memory Store — SQLite via sql.js (pure JS, no native deps)
//
// sql.js runs SQLite in-memory and we persist to disk on every write.
// FTS5 is NOT available in sql.js, so we use LIKE-based search with
// a helper table for indexed keywords.
// ---------------------------------------------------------------------------

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string; // ISO 8601
}

export interface Session {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  session_id: string;
  messages: Pick<Message, "role" | "content" | "timestamp">[];
}

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "minimi.db");

let _db: SqlJsDatabase | null = null;
let _initPromise: Promise<SqlJsDatabase> | null = null;

async function getDb(): Promise<SqlJsDatabase> {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const SQL = await initSqlJs();

    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Load existing DB from disk if it exists
    let db: SqlJsDatabase;
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    // Create tables
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content     TEXT NOT NULL,
        timestamp   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, id);

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp
        ON messages(timestamp);
    `);

    _db = db;
    persist();
    return db;
  })();

  return _initPromise;
}

/** Write the in-memory database to disk */
function persist(): void {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(title?: string): Promise<Session> {
  const db = await getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [id, title ?? null, now, now]
  );
  persist();
  return { id, title: title ?? null, created_at: now, updated_at: now };
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);
  const results: Session[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as Session;
    results.push(row);
  }
  stmt.free();
  return results;
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  stmt.bind([id]);
  let result: Session | undefined;
  if (stmt.step()) {
    result = stmt.getAsObject() as unknown as Session;
  }
  stmt.free();
  return result;
}

export async function updateSessionTitle(
  id: string,
  title: string
): Promise<void> {
  const db = await getDb();
  db.run(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`, [
    title,
    new Date().toISOString(),
    id,
  ]);
  persist();
}

// ---------------------------------------------------------------------------
// Message CRUD
// ---------------------------------------------------------------------------

export async function saveMessage(
  sessionId: string,
  role: Message["role"],
  content: string
): Promise<Message> {
  const db = await getDb();
  const timestamp = new Date().toISOString();

  db.run(
    `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
    [sessionId, role, content, timestamp]
  );

  // Get the last inserted row id
  const idResult = db.exec(`SELECT last_insert_rowid() as id`);
  const id = idResult[0]?.values[0]?.[0] as number;

  // Touch session updated_at
  db.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [
    timestamp,
    sessionId,
  ]);

  persist();

  return { id, session_id: sessionId, role, content, timestamp };
}

export async function getSessionMessages(
  sessionId: string,
  limit?: number
): Promise<Message[]> {
  const db = await getDb();
  let sql: string;
  let params: SqlValue[];

  if (limit) {
    sql = `SELECT * FROM (
      SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
    ) sub ORDER BY id ASC`;
    params = [sessionId, limit];
  } else {
    sql = `SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`;
    params = [sessionId];
  }

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: Message[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as unknown as Message);
  }
  stmt.free();
  return results;
}

// ---------------------------------------------------------------------------
// Memory search (LIKE-based + date filtering)
// ---------------------------------------------------------------------------

export async function searchMemory(opts: {
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  sessionId?: string;
  limit?: number;
}): Promise<MemorySearchResult[]> {
  const db = await getDb();
  const limit = opts.limit ?? 10;

  // Build search query
  let sql = `SELECT * FROM messages WHERE 1=1`;
  const params: SqlValue[] = [];

  if (opts.query) {
    const STOP_WORDS = new Set([
      "what", "did", "ask", "you", "about", "when", "where", "which",
      "tell", "have", "been", "were", "that", "this", "from", "with",
      "the", "and", "for", "any", "has", "your", "our", "are", "still"
    ]);

    // Split query into keywords, preferring non-stopwords
    const allKeywords = opts.query
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .split(/\s+/)
      .filter((k) => k.length > 1);

    const filteredKeywords = allKeywords.filter((k) => !STOP_WORDS.has(k));
    const keywords = filteredKeywords.length > 0 ? filteredKeywords : allKeywords;

    if (keywords.length > 0) {
      // Match messages containing ANY of the keywords
      const clauses = keywords.map(() => `content LIKE ?`);
      sql += ` AND (${clauses.join(" OR ")})`;
      for (const kw of keywords) {
        params.push(`%${kw}%`);
      }
    }
  }

  if (opts.sessionId) {
    sql += ` AND session_id = ?`;
    params.push(opts.sessionId);
  }

  if (opts.dateFrom) {
    const fromStr = opts.dateFrom.includes("T")
      ? opts.dateFrom
      : `${opts.dateFrom}T00:00:00.000Z`;
    sql += ` AND timestamp >= ?`;
    params.push(fromStr);
  }

  if (opts.dateTo) {
    const toStr = opts.dateTo.includes("T")
      ? opts.dateTo
      : `${opts.dateTo}T23:59:59.999Z`;
    sql += ` AND timestamp <= ?`;
    params.push(toStr);
  }

  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit * 5); // Get extra messages for context grouping

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const matched: Message[] = [];
  while (stmt.step()) {
    matched.push(stmt.getAsObject() as unknown as Message);
  }
  stmt.free();

  if (matched.length === 0) return [];

  // For each matched message, get surrounding context (3 before + 3 after)
  const contextMessages = new Map<number, Message>();
  for (const msg of matched.slice(0, limit * 2)) {
    const ctxStmt = db.prepare(
      `SELECT * FROM messages WHERE session_id = ? AND id BETWEEN ? AND ? ORDER BY id`
    );
    ctxStmt.bind([msg.session_id, msg.id - 3, msg.id + 3]);
    while (ctxStmt.step()) {
      const ctxMsg = ctxStmt.getAsObject() as unknown as Message;
      contextMessages.set(ctxMsg.id, ctxMsg);
    }
    ctxStmt.free();
  }

  // Group by session
  const grouped = new Map<string, Message[]>();
  const sortedMsgs = [...contextMessages.values()].sort(
    (a, b) => a.id - b.id
  );

  for (const msg of sortedMsgs) {
    if (!grouped.has(msg.session_id)) grouped.set(msg.session_id, []);
    grouped.get(msg.session_id)!.push(msg);
  }

  // Format results
  const results: MemorySearchResult[] = [];
  for (const [sessionId, msgs] of grouped) {
    results.push({
      session_id: sessionId,
      messages: msgs.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    });
  }

  return results.slice(0, limit);
}
