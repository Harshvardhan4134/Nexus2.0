/**
 * TinyFish Browser Control Service
 *
 * TinyFish provides a managed browser control API. It handles DOM-based
 * interactions (navigate, click, type, extract) without needing a local browser.
 *
 * API: https://api.tinyfish.io
 * Docs: https://tinyfish.io/docs
 */

export interface TinyFishConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface TinyFishSession {
  sessionId: string;
  browserUrl?: string;
}

export interface PageState {
  url: string;
  title: string;
  html?: string;
  text?: string;
  screenshot?: string;
  isSparseDom: boolean;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  pageState?: PageState;
  extractedData?: Record<string, unknown>;
}

const TINYFISH_BASE = "https://api.tinyfish.io";

/**
 * Create a new TinyFish browser session.
 */
export async function createSession(config: TinyFishConfig): Promise<TinyFishSession> {
  const res = await fetch(`${config.baseUrl ?? TINYFISH_BASE}/v1/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
    },
    body: JSON.stringify({ options: { headless: true, timeout: 30000 } }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TinyFish create session failed ${res.status}: ${err}`);
  }

  return (await res.json()) as TinyFishSession;
}

/**
 * Navigate to a URL and return the resulting page state.
 */
export async function navigate(
  sessionId: string,
  url: string,
  config: TinyFishConfig
): Promise<PageState> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/navigate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ url, waitFor: "networkidle" }),
    }
  );

  if (!res.ok) {
    throw new Error(`TinyFish navigate failed ${res.status}`);
  }

  const data = (await res.json()) as {
    url: string;
    title: string;
    html?: string;
    text?: string;
    screenshot?: string;
  };

  return {
    url: data.url,
    title: data.title,
    html: data.html,
    text: data.text,
    screenshot: data.screenshot,
    isSparseDom: isSparseDom(data.html ?? ""),
  };
}

/**
 * Click an element using a CSS selector.
 */
export async function clickElement(
  sessionId: string,
  selector: string,
  config: TinyFishConfig
): Promise<ActionResult> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/click`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ selector }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `Click failed (${res.status}): ${text}` };
  }

  return { success: true };
}

/**
 * Click at specific pixel coordinates (used after Kimi vision identifies target).
 */
export async function clickAtCoordinates(
  sessionId: string,
  x: number,
  y: number,
  config: TinyFishConfig
): Promise<ActionResult> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/click`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ coordinates: { x, y } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `Click at coordinates failed (${res.status}): ${text}` };
  }

  return { success: true };
}

/**
 * Type text into a focused input.
 */
export async function typeText(
  sessionId: string,
  selector: string,
  text: string,
  config: TinyFishConfig
): Promise<ActionResult> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/type`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ selector, text }),
    }
  );

  if (!res.ok) {
    const t = await res.text();
    return { success: false, error: `Type failed (${res.status}): ${t}` };
  }

  return { success: true };
}

/**
 * Type at specific pixel coordinates (vision-guided).
 */
export async function typeAtCoordinates(
  sessionId: string,
  x: number,
  y: number,
  text: string,
  config: TinyFishConfig
): Promise<ActionResult> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/type`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ coordinates: { x, y }, text }),
    }
  );

  if (!res.ok) {
    const t = await res.text();
    return { success: false, error: `Type at coordinates failed (${res.status}): ${t}` };
  }

  return { success: true };
}

/**
 * Capture a screenshot of the current page.
 */
export async function captureScreenshot(
  sessionId: string,
  config: TinyFishConfig
): Promise<string | null> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/screenshot`,
    {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
    }
  );

  if (!res.ok) return null;

  const data = (await res.json()) as { base64?: string; data?: string };
  return data.base64 ?? data.data ?? null;
}

/**
 * Get current page state including HTML, text content, and screenshot.
 */
export async function getPageState(
  sessionId: string,
  config: TinyFishConfig
): Promise<PageState> {
  const res = await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}/page`,
    {
      method: "GET",
      headers: { "X-API-Key": config.apiKey },
    }
  );

  if (!res.ok) throw new Error(`TinyFish getPageState failed ${res.status}`);

  const data = (await res.json()) as {
    url: string;
    title: string;
    html?: string;
    text?: string;
    screenshot?: string;
  };

  return {
    url: data.url,
    title: data.title,
    html: data.html,
    text: data.text,
    screenshot: data.screenshot,
    isSparseDom: isSparseDom(data.html ?? ""),
  };
}

/**
 * Close/terminate a TinyFish session.
 */
export async function closeSession(
  sessionId: string,
  config: TinyFishConfig
): Promise<void> {
  await fetch(
    `${config.baseUrl ?? TINYFISH_BASE}/v1/sessions/${sessionId}`,
    {
      method: "DELETE",
      headers: { "X-API-Key": config.apiKey },
    }
  );
}

/**
 * Determine if the DOM is sparse (SPA shell with little real content).
 * Triggers vision fallback when true.
 */
export function isSparseDom(html: string): boolean {
  if (!html || html.length < 500) return true;

  const textContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = textContent.split(" ").filter((w) => w.length > 2).length;

  const hasInteractiveElements =
    /<(button|input|textarea|select|a\s)[^>]*>/i.test(html);

  return wordCount < 30 || !hasInteractiveElements;
}
