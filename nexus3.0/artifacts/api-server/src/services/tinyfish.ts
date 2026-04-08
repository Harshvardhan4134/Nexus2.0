/**
 * TinyFish Web Agent — AI-powered browser automation.
 *
 * Real API base: https://agent.tinyfish.ai
 * Docs:         https://docs.tinyfish.ai
 *
 * Key endpoints:
 *   POST /v1/automation/run-sse  — stream an AI automation with natural language goal
 *   POST /v1/automation/run      — synchronous (blocks until done)
 *   POST /v1/browser             — create a raw CDP cloud browser session
 */

const TINYFISH_BASE = "https://agent.tinyfish.ai";

export interface TinyFishConfig {
  apiKey: string;
}

export interface TinyFishRunResult {
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  result?: Record<string, unknown> | null;
  error?: string;
  streamingUrl?: string;
  runId?: string;
}

export interface TinyFishBrowserSession {
  sessionId: string;
  cdpUrl: string;
  baseUrl: string;
}

/**
 * Run an AI automation synchronously and wait for the result.
 * Use for short tasks (< 60s). Pass `onProgress` for live log lines.
 */
export async function runAutomation(
  config: TinyFishConfig,
  opts: {
    url: string;
    goal: string;
    browserProfile?: "lite" | "stealth";
    useVault?: boolean;
    onProgress?: (msg: string) => void;
    onStreamingUrl?: (url: string) => void;
  }
): Promise<TinyFishRunResult> {
  const { url, goal, browserProfile = "stealth", useVault = false, onProgress, onStreamingUrl } = opts;

  const res = await fetch(`${TINYFISH_BASE}/v1/automation/run-sse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify({
      url,
      goal,
      browser_profile: browserProfile,
      use_vault: useVault,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`TinyFish automation failed ${res.status}: ${err}`);
  }

  // Parse SSE stream
  const reader = res.body?.getReader();
  if (!reader) throw new Error("TinyFish: no response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let streamingUrl: string | undefined;
  let runId: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;

      try {
        const event = JSON.parse(json) as {
          type: string;
          run_id?: string;
          purpose?: string;
          streaming_url?: string;
          status?: string;
          result?: Record<string, unknown> | null;
          error?: string;
        };

        if (event.run_id) runId = event.run_id;

        if (event.type === "STREAMING_URL" && event.streaming_url) {
          streamingUrl = event.streaming_url;
          onStreamingUrl?.(streamingUrl);
          onProgress?.(`TinyFish live view: ${streamingUrl}`);
        }

        if (event.type === "PROGRESS" && event.purpose) {
          onProgress?.(event.purpose);
        }

        if (event.type === "COMPLETE") {
          return {
            status: (event.status as TinyFishRunResult["status"]) ?? "COMPLETED",
            result: event.result ?? null,
            error: event.error,
            streamingUrl,
            runId,
          };
        }
      } catch {
        /* skip malformed SSE line */
      }
    }
  }

  return { status: "FAILED", error: "Stream ended without COMPLETE event", streamingUrl, runId };
}

/**
 * Create a raw TinyFish cloud browser session.
 * Returns a CDP WebSocket URL you can pass to Playwright's connectOverCDP().
 */
export async function createBrowserSession(
  config: TinyFishConfig,
  opts?: { url?: string }
): Promise<TinyFishBrowserSession> {
  const res = await fetch(`${TINYFISH_BASE}/v1/browser`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify(opts?.url ? { url: opts.url } : {}),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`TinyFish create browser session failed ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    session_id: string;
    cdp_url: string;
    base_url: string;
  };

  return {
    sessionId: data.session_id,
    cdpUrl: data.cdp_url,
    baseUrl: data.base_url,
  };
}

/**
 * Determine if the DOM is sparse (SPA shell with little real content).
 */
export function isSparseDom(html: string): boolean {
  if (!html || html.length < 500) return true;
  const textContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = textContent.split(" ").filter((w) => w.length > 2).length;
  const hasInteractiveElements = /<(button|input|textarea|select|a\s)[^>]*>/i.test(html);
  return wordCount < 30 || !hasInteractiveElements;
}
