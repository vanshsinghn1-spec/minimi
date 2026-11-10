// ---------------------------------------------------------------------------
// Tavily Web Search Client
// Free tier: 1000 searches/month at https://tavily.com
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface SearchResponse {
  answer: string | null;
  results: SearchResult[];
  query: string;
}

export async function tavilySearch(query: string): Promise<SearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set. Get a free key at https://tavily.com"
    );
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: 5,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    answer?: string;
    results: { title: string; url: string; content: string; score: number }[];
  };

  return {
    answer: data.answer ?? null,
    results: data.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content.slice(0, 1000), // Cap content length
      score: r.score,
    })),
    query,
  };
}

/**
 * Run multiple searches in parallel and return all results.
 */
export async function tavilySearchMultiple(
  queries: string[]
): Promise<SearchResponse[]> {
  return Promise.all(queries.map((q) => tavilySearch(q)));
}

