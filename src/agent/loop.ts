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

const MODEL = "gemini-2.0-flash";
const MAX_TOOL_ITERATIONS = 10;
const CONTEXT_MESSAGE_LIMIT = 30; // Recent messages to include as context

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

  // 3. Build the messages array for the LLM
  const systemPrompt = buildSystemPrompt(new Date().toISOString());
  const llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map(
      (m) =>
        ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }) satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam
    ),
  ];

  // 4. Agent loop — call LLM, execute tools, repeat
  let iterations = 0;
  let fullResponse = "";

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    try {
      const stream = await getClient().chat.completions.create({
        model: MODEL,
        messages: llmMessages,
        tools: toolDefinitions,
        stream: true,
      });

      // Accumulate streamed response
      let contentBuffer = "";
      const toolCalls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[] = [];
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Accumulate tool calls from deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id ?? "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name)
              toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments)
              toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }

        // Stream content chunks to caller
        if (delta.content) {
          contentBuffer += delta.content;
          yield { type: "chunk", data: delta.content };
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      // Handle tool calls — check both finish_reason and accumulated tool calls
      if (toolCalls.length > 0) {
        // Add assistant message with tool calls to context
        llmMessages.push({
          role: "assistant",
          content: contentBuffer || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });

        // Execute each tool call
        for (const tc of toolCalls) {
          const toolName = tc.function.name;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          // Emit status event
          const statusMsg = formatToolStatus(toolName, args);
          yield { type: "status", data: statusMsg };

          // Execute the tool
          let toolResult: string;
          try {
            toolResult = await executeTool(toolName, args);
          } catch (err) {
            toolResult = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Add tool result to context
          llmMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolResult,
          });
        }

        // Continue the loop — LLM will process tool results
        continue;
      }

      // No tool calls — we're done
      fullResponse = contentBuffer;
      break;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { type: "error", data: errMsg };
      fullResponse = `I encountered an error: ${errMsg}`;
      break;
    }
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    yield {
      type: "chunk",
      data: "\n\n*(Reached maximum tool call limit)*",
    };
    fullResponse += "\n\n*(Reached maximum tool call limit)*";
  }

  // 5. Save assistant response to memory
  if (fullResponse) {
    await saveMessage(sessionId, "assistant", fullResponse);
  }

  // 6. Auto-generate session title from first exchange
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
      return `Searching the web (${queries.length} queries)…`;
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
    const res = await getClient().chat.completions.create({
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
