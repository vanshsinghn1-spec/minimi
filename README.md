# Minimi — Chat Agent with Web Search and Memory

A lightweight, high-performance chat agent that searches the web and maintains conversational memory across sessions. Built for the Minimi hiring challenge.

- **Live Demo:** [https://minimi-8giv.onrender.com](https://minimi-8giv.onrender.com)
- **Repository:** [https://github.com/vanshsinghn1-spec/minimi](https://github.com/vanshsinghn1-spec/minimi)
- **Architecture Document:** [DESIGN.md](./DESIGN.md)

---

## Overview

Minimi is designed to excel at temporal reasoning, historical context retrieval, and real-time verification. It specifically addresses query patterns where an agent must recall past discussions and cross-reference them with current web data (e.g., verifying whether shortlisted tool pricing or product features have changed since a prior conversation).

Key capabilities:
- **Autonomous Tool Invocation:** The agent dynamically decides when to query the live web versus when to retrieve prior conversation history.
- **Parallel Query Execution:** Batches multiple search queries concurrently when evaluating sets of entities (e.g., comparing multiple vendors or competitors).
- **Zero-Native Storage Engine:** Employs an in-process SQLite instance via WebAssembly (`sql.js`), guaranteeing clean installation across all operating systems without native build tools (`node-gyp`).
- **Streaming User Experience:** Delivers incremental responses and intermediate tool statuses via Server-Sent Events (SSE).

---

## Live Deployment

The service is deployed on Render and accessible at:
[https://minimi-8giv.onrender.com](https://minimi-8giv.onrender.com)

### Deploying Your Own Instance

#### Option A: Render Blueprint
1. Fork or push this repository to your GitHub account.
2. In the [Render Dashboard](https://dashboard.render.com/), select **New +** > **Blueprint**.
3. Connect your repository. Render will automatically parse `render.yaml`.
4. Provide your `GEMINI_API_KEY` and `TAVILY_API_KEY` in the environment configuration prompts.
5. Click **Apply**.

#### Option B: Docker
```bash
docker build -t minimi .
docker run -p 3000:3000 --env-file .env minimi
```

---

## Local Development Setup

### Prerequisites
- Node.js 20 or higher
- npm 9 or higher

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/vanshsinghn1-spec/minimi.git
cd minimi

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
```

Add your API keys to `.env`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
TAVILY_API_KEY=your_tavily_api_key_here
PORT=3000
```

### Running the Application

```bash
# Start the development server with hot-reload
npm run dev

# Or build and run production bundle
npm run build
npm start
```

Once running, navigate to `http://localhost:3000` in your web browser.

---

## API Key Provisioning

Both required services offer free access tiers:

| Provider | Purpose | Free Quota | Dashboard |
|---|---|---|---|
| Google Gemini | Model reasoning & function calling | Free access available | [Google AI Studio](https://aistudio.google.com/apikey) |
| Tavily Search | Search engine tailored for LLMs | 1,000 searches / month | [Tavily](https://tavily.com) |

---

## Architecture Summary

A detailed breakdown of design trade-offs, rejected approaches, and future roadmap is documented in [DESIGN.md](./DESIGN.md).

```
[Browser / Client] 
       │ (SSE Stream)
       ▼
[Express Server] ── (Agent Loop) ──▶ [Google Gemini]
       │                                   │
       ├─ (Local Query) ──▶ [SQLite Store (sql.js)]
       │
       └─ (Parallel HTTP) ─▶ [Tavily Web Search]
```

- **Loop Architecture:** Avoids heavy agent frameworks (such as LangChain) in favor of a direct, typed, ~120-line orchestration loop using the OpenAI SDK client interface.
- **Memory Subsystem:** Messages and sessions are indexed with ISO-8601 timestamps. The model receives temporal anchors and can query historical conversations by keyword and date filters.
- **Rate Limit Resilience:** Built-in exponential backoff handles upstream rate limits (HTTP 429) gracefully without crashing active streams.

---

## Technology Stack

- **Runtime:** Node.js, TypeScript (ES2022)
- **Model Interface:** Google Gemini (OpenAI-compatible endpoint via `openai` SDK)
- **Search Provider:** Tavily Search API
- **Persistence:** SQLite (`sql.js` WebAssembly build)
- **Server:** Express.js with Server-Sent Events (SSE)
- **Client:** HTML5, CSS3, vanilla JavaScript, Marked.js, DOMPurify
