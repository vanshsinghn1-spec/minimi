# Minimi — Chat Agent with Web Search & Memory

A high-performance chat agent that searches the web and remembers past conversations across sessions. Built with Google Gemini, Tavily Web Search, and SQLite memory store.

Submitted for the **Minimi Hiring Challenge: Build a Chat Agent**.

---

## Live Demo & Deployment

### Option 1: Deploy to Render (Recommended Free Hosting)
1. Fork or push this repository to GitHub.
2. Go to [Render Dashboard](https://dashboard.render.com/) and click **New +** → **Blueprint** (or **Web Service**).
3. Connect your repo `minimi`. Render detects `render.yaml` automatically.
4. Set two environment variables:
   - `GEMINI_API_KEY`: Your Gemini key
   - `TAVILY_API_KEY`: Your Tavily key
5. Click **Deploy**. Your app will be live at `https://your-app.onrender.com`.

### Option 2: Run with Docker
```bash
docker build -t minimi .
docker run -p 3000:3000 --env-file .env minimi
```

---

## Local Development (Quick Start)

```bash
# 1. Clone repository
git clone https://github.com/vanshsinghn1-spec/minimi.git
cd minimi

# 2. Install dependencies
npm install

# 3. Configure API keys (both are 100% free)
cp .env.example .env
# Edit .env with your GEMINI_API_KEY and TAVILY_API_KEY

# 4. Start the dev server
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## API Keys (All Free)

| Key | Description | Where to get it |
|-----|-------------|-----------------|
| `GEMINI_API_KEY` | Reasoning & tool orchestration | [Google AI Studio](https://aistudio.google.com/apikey) — free |
| `TAVILY_API_KEY` | Real-time web search | [Tavily](https://tavily.com) — free (1,000 searches/mo) |

---

## Architecture & Design

See [DESIGN.md](./DESIGN.md) for the full 1-page architecture document covering:
- How it works (streaming tool-calling agent loop, SQLite memory store with temporal reasoning, parallel web searches)
- Why it was built this way (zero framework overhead, pure-JS SQLite, streaming SSE)
- Rejected alternatives (LangChain, vector databases, heavy RAG)
- What we would build with another week

---

## Tech Stack

- **LLM:** Google Gemini (`gemini-3-flash-preview` / `gemini-2.5-flash` via OpenAI-compatible endpoint)
- **Web Search:** Tavily AI Search API (parallel multi-query search)
- **Memory Store:** SQLite via `sql.js` (pure JS/Wasm — zero native C++ compilation, portable across all OSes)
- **Server:** Express.js + Server-Sent Events (SSE) streaming
- **Frontend:** Responsive vanilla HTML5/CSS3/JS with Marked.js & DOMPurify
