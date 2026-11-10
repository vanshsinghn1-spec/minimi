// ---------------------------------------------------------------------------
// Tool definitions and execution
// ---------------------------------------------------------------------------

import { tavilySearchMultiple, type SearchResponse } from "../search/tavily.js";
import { searchMemory, type MemorySearchResult } from "../memory/store.js";
import type OpenAI from "openai";

// ---------------------------------------------------------------------------
// Tool schemas (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current, real-time information. Supports multiple parallel queries. Use for facts, news, pricing, product updates, or to check if something has changed.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            description:
              'Search queries to execute. Use multiple queries to check several things at once (e.g., ["HubSpot pricing 2024", "Salesforce pricing 2024"]).',
          },
        },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description:
        'Search past conversations with this user. Use when they reference something discussed before (e.g., "last Tuesday", "what did I ask you", "has anything changed since").',
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords to search for in past conversations (e.g., 'CRM tools', 'Postgres hosting')",
          },
          date_from: {
            type: "string",
            description:
              "Start date filter in ISO 8601 (e.g., '2024-11-04'). Use when the user mentions a specific date or relative date like 'last Tuesday'.",
          },
          date_to: {
            type: "string",
            description:
              "End date filter in ISO 8601. Defaults to now if omitted.",
          },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface ToolCallEvent {
  type: "tool_start" | "tool_end";
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  onEvent?: (event: ToolCallEvent) => void
): Promise<string> {
  onEvent?.({ type: "tool_start", name, args });

  let result: unknown;

  switch (name) {
    case "web_search": {
      const queries = args.queries as string[];
      const searchResults: SearchResponse[] =
        await tavilySearchMultiple(queries);

      // Format results for the LLM
      result = searchResults.map((sr) => ({
        query: sr.query,
        answer: sr.answer,
        sources: sr.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
        })),
      }));
      break;
    }

    case "recall_memory": {
      const memResults: MemorySearchResult[] = await searchMemory({
        query: args.query as string | undefined,
        dateFrom: args.date_from as string | undefined,
        dateTo: args.date_to as string | undefined,
        limit: 8,
      });

      if (memResults.length === 0) {
        result = {
          found: false,
          message: "No matching past conversations found.",
        };
      } else {
        result = {
          found: true,
          conversations: memResults,
        };
      }
      break;
    }

    default:
      result = { error: `Unknown tool: ${name}` };
  }

  onEvent?.({ type: "tool_end", name, result });
  return JSON.stringify(result);
}
