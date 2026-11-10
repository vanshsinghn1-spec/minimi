# Minimi — Chat Agent with Web Search & Memory

A chat agent that searches the web and remembers past conversations. Built with Gemini 2.0 Flash, Tavily Search, and SQLite.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in your API keys (both are free)
cp .env.example .env

# 3. Start the dev server
npm run dev
```

Then open **http://localhost:3000** in your browser.

## API Keys (Free)

| Key | Where to get it |
|-----|-----------------|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) — free |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com) — free (1000 searches/month) |

## Architecture

See [DESIGN.md](./DESIGN.md) for the full architecture document.

**TL;DR:** An agent loop where Gemini 2.0 Flash autonomously decides when to search the web (Tavily) or recall past conversations (SQLite). Responses stream to the browser via SSE.

## Tech Stack

- **LLM:** Google Gemini 2.0 Flash (via OpenAI-compatible endpoint)
- **Web Search:** Tavily API
- **Memory:** SQLite (via sql.js, pure JavaScript)
- **Server:** Express + Server-Sent Events
- **Frontend:** Vanilla HTML/CSS/JS with Marked.js for markdown

