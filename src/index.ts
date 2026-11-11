// ---------------------------------------------------------------------------
// Minimi — Express server with SSE streaming
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { runAgent } from "./agent/loop.js";
import {
  createSession,
  listSessions,
  getSession,
  getSessionMessages,
} from "./memory/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Resolve static files directory whether running in dev (src/) or production (dist/)
const publicDir = [
  path.join(__dirname, "public"),
  path.join(__dirname, "../src/public"),
  path.resolve("src/public"),
  path.resolve("public"),
].find((dir) => fs.existsSync(dir)) || path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());
app.use(express.static(publicDir));

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// List all sessions
app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await listSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Create a new session
app.post("/api/sessions", async (req, res) => {
  try {
    const { title } = req.body ?? {};
    const session = await createSession(title);
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get session details
app.get("/api/sessions/:id", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get messages for a session
app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const messages = await getSessionMessages(req.params.id);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Chat endpoint — SSE streaming
// ---------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
  const { session_id, message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  // Auto-create session if not provided
  let sessionId: string = session_id;
  if (!sessionId) {
    const session = await createSession();
    sessionId = session.id;
  } else {
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Session-Id": sessionId,
  });

  // Send the session ID as the first event (for new sessions)
  res.write(`event: session\ndata: ${JSON.stringify({ id: sessionId })}\n\n`);

  try {
    for await (const event of runAgent(sessionId, message)) {
      const sseData = JSON.stringify({
        type: event.type,
        data: event.data,
      });
      res.write(`event: ${event.type}\ndata: ${sseData}\n\n`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", data: errMsg })}\n\n`
    );
  }

  res.end();
});

// ---------------------------------------------------------------------------
// Serve the SPA for any non-API route
// ---------------------------------------------------------------------------

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║          Minimi Chat Agent               ║
  ║   http://localhost:${PORT}                  ║
  ╚══════════════════════════════════════════╝
  `);
});
