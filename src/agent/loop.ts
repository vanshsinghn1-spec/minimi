// ---------------------------------------------------------------------------
// Core agent loop — streaming tool-calling cycle
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import { buildSystemPrompt } from "./system-prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";
import {
  saveMessage,
  getSessionMessages,
  updateSessionTitle,
} from "../memory/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEvent {
  type: "status" | "chunk" | "done" | "error";
  data: string;
}

// ---------------------------------------------------------------------------
// OpenAI client — pointed at Gemini's OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey"
    );
  }

  _client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });

  return _client;
}

const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const MAX_TOOL_ITERATIONS = 10;
const CONTEXT_MESSAGE_LIMIT = 30; // Recent messages to include as context

// ---------------------------------------------------------------------------
// Helper: chunk text for smooth streaming delivery
// ---------------------------------------------------------------------------

async function* streamChunks(text: string, chunkSize = 16, delayMs = 12): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: chat completion with automatic retry on rate limit (429)
// ---------------------------------------------------------------------------

async function createCompletionWithRetry(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  maxRetries = 3
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let attempt = 0;
  while (true) {
    try {
      return await getClient().chat.completions.create(params);
    } catch (err: any) {
      attempt++;
      const isRateLimit =
        err?.status === 429 ||
        err?.message?.includes("429") ||
        err?.message?.includes("RESOURCE_EXHAUSTED");
      if (isRateLimit && attempt <= maxRetries) {
        const delay = attempt * 2500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Main agent runner — async generator yielding events
// ---------------------------------------------------------------------------

export async function* runAgent(
  sessionId: string,
  userMessage: string
): AsyncGenerator<AgentEvent> {
  // 1. Save user message to memory
  await saveMessage(sessionId, "user", userMessage);

  // 2. Load recent conversation history for context
  const history = await getSessionMessages(sessionId, CONTEXT_MESSAGE_LIMIT);

  // 3. Format current date & time for system prompt
  const now = new Date();
  const formattedDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const systemPrompt = buildSystemPrompt(
    `${formattedDate}, ${timeStr} (ISO: ${now.toISOString()})`
  );

  // 4. Build messages array with timestamp annotations on history
  const llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.slice(0, -1).map(
      (m) =>
        ({
          role: m.role as "user" | "assistant",
          content: `[${new Date(m.timestamp).toLocaleDateString("en-US", {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
          })}] ${m.content}`,
        }) satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam
    ),
    { role: "user", content: userMessage },
  ];

  // 5. Agent loop — call LLM, execute tools, repeat
  let iterations = 0;
  let fullResponse = "";

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    try {
      const response = await createCompletionWithRetry({
        model: MODEL,
        messages: llmMessages,
        tools: toolDefinitions,
      });

      const choice = response.choices[0];
      if (!choice) {
        break;
      }

      const msg = choice.message;

      // Check if LLM requested tool execution
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Keep the exact assistant message with tool calls & metadata in context
        llmMessages.push(msg);

        // Execute each tool
        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          // Emit status update to the client
          const statusMsg = formatToolStatus(toolName, args);
          yield { type: "status", data: statusMsg };

          // Execute tool
          let toolResult: string;
          try {
            toolResult = await executeTool(toolName, args);
          } catch (err) {
            toolResult = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Feed tool response back to context
          llmMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolResult,
          });
        }

        // Loop continues so LLM can reason over tool outputs
        continue;
      }

      // Final response text generated
      if (msg.content) {
        fullResponse = msg.content;
        for await (const chunk of streamChunks(fullResponse)) {
          yield { type: "chunk", data: chunk };
        }
      }
      break;
    } catch (err) {
      let errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("429")) {
        errMsg = "Gemini API free-tier rate limit reached. Please wait 15–30 seconds and try again.";
      }
      yield { type: "error", data: errMsg };
      fullResponse = `I encountered an error: ${errMsg}`;
      break;
    }
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    const limitNote = "\n\n*(Reached maximum tool call limit)*";
    yield { type: "chunk", data: limitNote };
    fullResponse += limitNote;
  }

  // 6. Save assistant response to memory
  if (fullResponse) {
    await saveMessage(sessionId, "assistant", fullResponse);
  }

  // 7. Auto-generate session title if needed
  await maybeSetTitle(sessionId, userMessage);

  yield { type: "done", data: "" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatToolStatus(
  name: string,
  args: Record<string, unknown>
): string {
  switch (name) {
    case "web_search": {
      const queries = (args.queries as string[]) ?? [];
      if (queries.length === 1) return `Searching the web for "${queries[0]}"…`;
      return `Searching the web (${queries.length} parallel queries)…`;
    }
    case "recall_memory": {
      const query = args.query as string | undefined;
      if (query) return `Searching memory for "${query}"…`;
      return `Searching past conversations…`;
    }
    default:
      return `Using ${name}…`;
  }
}

/**
 * Auto-generate a session title from the first user message.
 */
async function maybeSetTitle(
  sessionId: string,
  userMessage: string
): Promise<void> {
  const messages = await getSessionMessages(sessionId);
  // Only set title on the first exchange (2 messages: user + assistant)
  if (messages.length > 2) return;

  try {
    const res = await createCompletionWithRetry({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: `Summarise this chat message in 5 words or fewer for a sidebar title. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nMessage: "${userMessage}"`,
        },
      ],
    });
    const title = res.choices[0]?.message?.content?.trim();
    if (title) {
      await updateSessionTitle(sessionId, title);
    }
  } catch {
    // Non-critical — silently ignore
  }
}
