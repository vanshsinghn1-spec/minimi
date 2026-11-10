# DESIGN.md — Minimi Chat Agent

## How It Works

Minimi is a chat agent with two capabilities: **web search** and **conversational memory**. It uses Google Gemini 2.0 Flash as its reasoning engine, Tavily for web search, and SQLite (via sql.js, a pure-JS SQLite implementation) for persistent conversation memory.

### Architecture

```
User (Browser) ──SSE──▶ Express Server ──▶ Agent Loop ──▶ Gemini 2.0 Flash
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                         web_search    recall_memory    (respond)
                         (Tavily)      (SQLite)
```

The agent loop is a streaming tool-calling cycle:

1. User message is saved to SQLite with a timestamp.
2. The last 30 messages from the current session are loaded as context.
3. The system prompt (with the current datetime) and conversation history are sent to Gemini.
4. Gemini decides whether to call tools, and which ones:
   - `web_search` — queries Tavily for current information (supports multiple parallel queries)
   - `recall_memory` — searches past conversations using keyword search with optional date filtering
5. Tool results feed back to Gemini, which may call more tools or generate a response.
6. The final response streams to the browser via Server-Sent Events.
7. The response is saved to memory.

### Memory System

Every message (user and assistant) is stored in SQLite (via sql.js, a pure-JavaScript SQLite implementation) with a session ID and ISO 8601 timestamp.

When `recall_memory` is called, it:
- Runs a keyword-based LIKE search across all stored messages
- Filters by date range if provided
- Returns matched messages plus 3 surrounding messages for context
- Groups results by session

The LLM decides when to search memory based on user cues ("last Tuesday", "what did I ask you", etc.). This is more efficient than injecting all history into every prompt.

### Web Search

Tavily's search API returns pre-extracted content (not just links), making it ideal for LLM consumption. The agent can run multiple search queries in parallel for multi-entity checks (e.g., checking pricing for 5 CRM tools).

## Why I Built It This Way

**Memory as a tool, not injected context.** The LLM decides when to search memory and formulates targeted queries. This scales to long conversation histories without wasting context on irrelevant messages. The alternative — injecting recent history into every prompt — breaks down with multi-session memory and costs tokens on irrelevant context.

**SQLite (sql.js) over vector embeddings.** For conversation memory, keyword search works well: users reference specific topics, tool names, and dates. Using sql.js (pure JavaScript SQLite) means zero native build dependencies — it installs and runs anywhere instantly without node-gyp or C++ compilers. Vector search would add an embedding API dependency, startup latency, and complexity — without meaningfully better recall for this use case.

**No framework.** The agent loop is ~100 lines of TypeScript. LangChain or similar frameworks would add abstraction that hides the architecture. For a hiring challenge judged on how you think, transparency matters. The code is the documentation.

**Gemini via OpenAI-compatible endpoint.** This gives us a free, fast, high-quality model with standard tool-calling semantics. The OpenAI SDK is well-typed and widely understood. Swapping to GPT-4o or Claude is a one-line change.

**SSE over WebSocket.** Server-Sent Events are simpler, work over HTTP, and auto-reconnect. We only need server→client streaming. WebSocket would add complexity for no benefit.

**Streaming everything.** Tool call status events stream to the UI so the user sees "Searching the web for X…" in real-time. This makes the agent feel responsive even during multi-step reasoning.

## What I Considered and Rejected

| Option | Why I rejected it |
|--------|-------------------|
| **LangChain** | Hides the agent loop behind abstractions. The loop is simple enough to build directly, and clarity matters for review. |
| **Vector DB (ChromaDB, Pinecone)** | Over-engineered for conversation memory. Structured SQL queries handle the actual patterns (keyword + date range) better and with zero infrastructure. |
| **Native SQLite (better-sqlite3)** | Requires node-gyp and a C++ compiler to build, which fails on many environments. `sql.js` is pure WebAssembly/JS, installs cleanly anywhere, and runs identically across all platforms. |
| **RAG pipeline** | The conversations are the documents. Structured search over timestamped messages is simpler and more precise than chunk-embed-retrieve. |
| **WebSocket** | Unnecessary bidirectional complexity for a request→stream pattern. SSE is sufficient. |
| **React/Vue frontend** | Adds a build step, bundle size, and complexity. Vanilla JS is fast, reviewable, and sufficient for a chat UI. |
| **Multiple LLM calls for routing** | Adding a "classifier" to decide tools before the main LLM call adds latency. Gemini's tool-calling is reliable enough to handle routing in a single call. |
| **DuckDuckGo scraping** | Unreliable, no API contract, may break. Tavily is purpose-built for AI agents and has a free tier. |

## What I'd Do With Another Week

1. **Embedding-based memory fallback.** When keyword search returns no results, fall back to semantic similarity search using embeddings. This catches cases where the user's phrasing doesn't share keywords with the stored messages.

2. **Conversation summarisation.** Periodically summarise old conversations into compressed summaries. Store these alongside raw messages for efficient long-term memory retrieval.

3. **Smart date parsing.** Use a library like chrono-node to robustly parse natural language dates ("last Tuesday", "two weeks ago", "the meeting on the 3rd"). Currently, the LLM handles this in the system prompt, but a dedicated parser would be more reliable.

4. **Source quality scoring.** Rank web search results by source authority and freshness. Prefer official product pages over blog posts for pricing queries.

5. **Tool result caching.** Cache web search results with a short TTL (e.g., 5 minutes) to avoid redundant API calls when the user asks follow-up questions about the same topic.

6. **Multi-model support.** Let users choose between Gemini, GPT-4o, and Claude via the UI. Different models have different strengths; the architecture supports this with a one-line change.

7. **Proactive freshness alerts.** Track which facts the agent has cited and their source dates. When the user revisits a topic, proactively note if the cited sources are getting stale.

8. **Better error recovery.** Retry failed tool calls with exponential backoff. Gracefully degrade when Tavily is down (report to user, suggest they try again).

9. **Export and import.** Let users export their conversation history as JSON/Markdown and import it into a new instance.

10. **Testing.** Add integration tests that simulate the three example queries end-to-end, verifying memory retrieval and web search are triggered correctly.
