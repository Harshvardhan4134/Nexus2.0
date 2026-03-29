/**
 * Live Browser — real Playwright execution with screenshot streaming.
 *
 * Key features:
 * - Persistent browser profile (login sessions survive across tasks)
 * - Interactive control (clicks/keyboard forwarded from the UI)
 * - Stealth mode (avoids bot detection)
 * - Screenshot streaming via SSE every 500ms
 *
 * Headed mode: set NEXUS_HEADED_BROWSER=1 (or PLAYWRIGHT_HEADED=1) to open a
 * visible Chromium window on the server. Set NEXUS_HEADED_BROWSER=0 to force
 * headless even when NODE_ENV=development (dev defaults to headed so login works
 * without relying on the screenshot stream).
 *
 * Your Chrome as a new tab: start Chrome with remote debugging, then set
 * PLAYWRIGHT_CDP_URL=http://127.0.0.1:9222 — Nexus connects and opens a tab
 * in that browser (same profile/session as that Chrome process).
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { findElementByVision, describePageContent } from "./kimi-vision.js";
import { isSparseDom } from "./tinyfish.js";
import { logger } from "../lib/logger.js";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "node:os";

export interface LiveBrowserOptions {
  kimiKey?: string;
  viewport?: { width: number; height: number };
  profileId?: string; // persistent profile key (default: "default")
}

export interface FrameEvent {
  frameBase64: string;
  url: string;
  title: string;
  timestamp: number;
}

export interface BrowserLog {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export interface BrowserAction {
  timestamp: string;
  action: string;
  params: Record<string, unknown>;
  result: string;
  status: "success" | "error" | "skipped";
  usedVision?: boolean;
  elementTarget?: { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
}

/** Where automation runs — exposed to UI for accurate “where to sign in” copy */
export type BrowserSurface = "headless" | "headed" | "cdp";

export interface LiveBrowserSession {
  sessionId: string;
  context: BrowserContext;
  page: Page;
  browserSurface: BrowserSurface;
  /** When set, session is attached to an existing Chrome via CDP (do not context.close()). */
  cdpBrowser?: Browser;
  attachedViaCdp?: boolean;
  currentFrame?: string;
  currentUrl: string;
  currentTitle: string;
  logs: BrowserLog[];
  actions: BrowserAction[];
  status: "running" | "completed" | "error" | "stopped";
  screenshotInterval?: ReturnType<typeof setInterval>;
  frameListeners: Set<(frame: FrameEvent) => void>;
  options: LiveBrowserOptions;
  waitingForUser: boolean;
  waitingMessage?: string;
}

const VIEWPORT = { width: 1280, height: 720 };

/** Cross-platform temp dir for persistent Chromium profiles */
const PROFILES_DIR = path.join(tmpdir(), "nexus-browser-profiles");

/**
 * Replit pre-installs Playwright browsers in the Nix store.
 * On Windows/macOS/Linux without that path, omit `executablePath` so Playwright uses its bundled Chromium.
 */
const REPLIT_CHROMIUM_FALLBACK =
  "/nix/store/kcvsxrmgwp3ffz5jijyy7wn9fcsjl4hz-playwright-browsers-1.55.0-with-cjk/chromium-1187/chrome-linux/chrome";

function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  if (fs.existsSync(REPLIT_CHROMIUM_FALLBACK)) {
    return REPLIT_CHROMIUM_FALLBACK;
  }
  return undefined;
}

/**
 * Headed = real OS window (same Playwright session tasks still run here).
 * The Nexus "Live Browser" panel remains a screenshot stream of this page.
 */
function isHeadedBrowser(): boolean {
  if (
    process.env.NEXUS_HEADED_BROWSER === "0" ||
    process.env.PLAYWRIGHT_HEADED === "0"
  ) {
    return false;
  }
  if (
    process.env.NEXUS_HEADED_BROWSER === "1" ||
    process.env.PLAYWRIGHT_HEADED === "1"
  ) {
    return true;
  }
  // Local dev: visible window by default so login is possible without relying on the screenshot stream
  return process.env.NODE_ENV === "development";
}

/** HTTP endpoint only, e.g. http://127.0.0.1:9222 (not a devtools ws:// URL). */
function resolveCdpEndpoint(): string | undefined {
  const raw =
    process.env.PLAYWRIGHT_CDP_URL?.trim() ||
    process.env.CHROME_CDP_URL?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
    logger.warn(
      {},
      "PLAYWRIGHT_CDP_URL must be http://host:port (not ws://). Example: http://127.0.0.1:9222",
    );
    return undefined;
  }
  return raw;
}

const STEALTH_INIT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  const g = globalThis as unknown as Record<string, unknown>;
  g.chrome = {
    runtime: {},
    loadTimes: () => ({}),
    csi: () => ({}),
    app: {},
  };
};

export async function launchLiveBrowser(
  sessionId: string,
  options: LiveBrowserOptions = {}
): Promise<LiveBrowserSession> {
  const profileId = options.profileId ?? "default";
  const userDataDir = path.join(PROFILES_DIR, profileId);
  fs.mkdirSync(userDataDir, { recursive: true });

  const viewport = options.viewport ?? VIEWPORT;
  const headed = isHeadedBrowser();
  const chromiumPath = resolveChromiumExecutable();
  const cdpEndpoint = resolveCdpEndpoint();

  if (cdpEndpoint) {
    logger.info(
      { sessionId, cdpEndpoint },
      "Connecting to Chrome via CDP — automation uses a new tab in that browser",
    );
    const cdpBrowser = await chromium.connectOverCDP(cdpEndpoint);
    const contexts = cdpBrowser.contexts();
    if (!contexts.length) {
      await cdpBrowser.close().catch(() => {});
      throw new Error(
        "CDP connected but no browser contexts found. Close other debug clients or restart Chrome with --remote-debugging-port.",
      );
    }
    const context = contexts[0];
    await context.addInitScript(STEALTH_INIT);
    const page = await context.newPage();
    await page.setViewportSize(viewport).catch(() => {});

    const session: LiveBrowserSession = {
      sessionId,
      context,
      page,
      browserSurface: "cdp",
      cdpBrowser,
      attachedViaCdp: true,
      currentUrl: "",
      currentTitle: "",
      logs: [],
      actions: [],
      status: "running",
      screenshotInterval: undefined,
      frameListeners: new Set(),
      options,
      waitingForUser: false,
    };
    addLog(
      session,
      "info",
      "CDP mode: using your Chrome — tasks run in the new tab Playwright opened (close the tab or end the session when done).",
    );
    startScreenshotLoop(session);
    return session;
  }

  if (headed) {
    logger.info(
      { sessionId },
      "Launching headed Chromium — a visible browser window will open on this machine (same session the API automates)",
    );
  }

  // Use launchPersistentContext so logins (Gmail, LinkedIn, etc.) persist
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !headed,
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    viewport,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=IsolateOrigins",
      "--disable-site-isolation-trials",
    ],
  });

  // Stealth: remove webdriver fingerprint on every page
  await context.addInitScript(STEALTH_INIT);

  const page = context.pages()[0] ?? await context.newPage();

  const session: LiveBrowserSession = {
    sessionId,
    context,
    page,
    browserSurface: headed ? "headed" : "headless",
    currentUrl: "",
    currentTitle: "",
    logs: [],
    actions: [],
    status: "running",
    screenshotInterval: undefined,
    frameListeners: new Set(),
    options,
    waitingForUser: false,
  };

  if (headed) {
    addLog(
      session,
      "info",
      "Headed mode: automation runs in the visible Chromium window on this machine.",
    );
  }

  startScreenshotLoop(session);
  return session;
}

/** Screenshot often fails while a page is mid-redirect; retry + nav hooks keep the live view fresh */
const SCREENSHOT_TIMEOUT_MS = 15_000;
const SCREENSHOT_RETRIES = 5;
const SCREENSHOT_RETRY_GAP_MS = 120;

function startScreenshotLoop(session: LiveBrowserSession) {
  const page = session.page;
  let navDebounce: ReturnType<typeof setTimeout> | undefined;

  const captureFrame = async () => {
    if (session.status !== "running") return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < SCREENSHOT_RETRIES; attempt++) {
      if (session.status !== "running") return;
      try {
        const buf = await page.screenshot({
          type: "jpeg",
          quality: 70,
          timeout: SCREENSHOT_TIMEOUT_MS,
          animations: "disabled",
        });
        const b64 = buf.toString("base64");
        session.currentFrame = b64;
        session.currentUrl = page.url();
        session.currentTitle = (await page.title().catch(() => "")) ?? "";

        const event: FrameEvent = {
          frameBase64: b64,
          url: session.currentUrl,
          title: session.currentTitle,
          timestamp: Date.now(),
        };
        for (const cb of session.frameListeners) {
          try {
            cb(event);
          } catch {
            /* listener closed */
          }
        }
        return;
      } catch (err) {
        lastErr = err;
        await delay(SCREENSHOT_RETRY_GAP_MS);
      }
    }
    logger.debug(
      { err: lastErr, sessionId: session.sessionId },
      "Live view screenshot failed after retries (page redirecting or busy)",
    );
  };

  const scheduleCaptureSoon = () => {
    if (navDebounce) clearTimeout(navDebounce);
    navDebounce = setTimeout(() => {
      navDebounce = undefined;
      void captureFrame();
    }, 200);
  };

  page.on("load", scheduleCaptureSoon);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) scheduleCaptureSoon();
  });

  session.screenshotInterval = setInterval(captureFrame, 400);
  void captureFrame();
}

export function addFrameListener(
  session: LiveBrowserSession,
  cb: (frame: FrameEvent) => void
): () => void {
  session.frameListeners.add(cb);
  if (session.currentFrame) {
    cb({ frameBase64: session.currentFrame, url: session.currentUrl, title: session.currentTitle, timestamp: Date.now() });
  }
  return () => session.frameListeners.delete(cb);
}

function addLog(session: LiveBrowserSession, level: BrowserLog["level"], message: string) {
  session.logs.push({ timestamp: new Date().toISOString(), level, message });
}

function addAction(
  session: LiveBrowserSession, action: string, params: Record<string, unknown>,
  result: string, status: BrowserAction["status"], extra?: Partial<BrowserAction>
) {
  session.actions.push({ timestamp: new Date().toISOString(), action, params, result, status, ...extra });
}

async function captureScreenshot(session: LiveBrowserSession): Promise<string | null> {
  try {
    const buf = await session.page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 });
    return buf.toString("base64");
  } catch { return null; }
}

// ─── Browser Actions ─────────────────────────────────────────────────────────

export async function navigate(
  session: LiveBrowserSession,
  url: string
): Promise<{ sparse: boolean; description?: string }> {
  addLog(session, "info", `Navigating to ${url}`);
  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await delay(800);
    const html = await session.page.content();
    const sparse = isSparseDom(html);
    addAction(session, "navigate", { url }, `Loaded: ${session.page.url()}`, "success");
    if (sparse && session.options.kimiKey) {
      const screenshot = await captureScreenshot(session);
      if (screenshot) {
        const description = await describePageContent(screenshot, url, { apiKey: session.options.kimiKey }).catch(() => "");
        addLog(session, "debug", `Vision: ${description.slice(0, 150)}`);
        return { sparse: true, description };
      }
    }
    return { sparse };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(session, "error", `Navigation failed: ${msg}`);
    addAction(session, "navigate", { url }, msg, "error");
    return { sparse: false };
  }
}

export async function click(
  session: LiveBrowserSession,
  selector: string,
  intent: string
): Promise<boolean> {
  addLog(session, "info", `Clicking: "${intent}"`);
  try {
    await session.page.click(selector, { timeout: 5000 });
    addAction(session, "click", { selector, intent }, "Clicked via DOM selector", "success");
    await delay(600);
    return true;
  } catch { /* try vision */ }

  if (session.options.kimiKey) {
    const screenshot = await captureScreenshot(session);
    if (screenshot) {
      try {
        const target = await findElementByVision(screenshot, intent, VIEWPORT.width, VIEWPORT.height, { apiKey: session.options.kimiKey! });
        if (target) {
          await session.page.mouse.click(target.centerX, target.centerY);
          addAction(session, "click", { intent }, "Clicked via Kimi vision", "success", { usedVision: true, elementTarget: target });
          await delay(600);
          return true;
        }
      } catch { /* vision failed */ }
    }
  }

  addAction(session, "click", { selector, intent }, "Element not found", "skipped");
  return false;
}

export async function clickCoordinates(
  session: LiveBrowserSession,
  x: number,
  y: number
): Promise<void> {
  await session.page.mouse.click(x, y);
  addLog(session, "info", `User clicked at (${x}, ${y})`);
  addAction(session, "click", { x, y, source: "live_view" }, `Live view click at ${x},${y}`, "success");
  await delay(300);
}

export async function typeText(
  session: LiveBrowserSession,
  selector: string,
  text: string,
  intent: string
): Promise<boolean> {
  addLog(session, "info", `Typing "${text}" into ${intent}`);
  try {
    await session.page.fill(selector, text, { timeout: 5000 });
    addAction(session, "type", { selector, text, intent }, "Typed via DOM selector", "success");
    await delay(300);
    return true;
  } catch { /* try vision */ }

  if (session.options.kimiKey) {
    const screenshot = await captureScreenshot(session);
    if (screenshot) {
      try {
        const target = await findElementByVision(screenshot, intent, VIEWPORT.width, VIEWPORT.height, { apiKey: session.options.kimiKey! });
        if (target) {
          await session.page.mouse.click(target.centerX, target.centerY);
          await delay(200);
          await session.page.keyboard.type(text, { delay: 40 });
          addAction(session, "type", { text, intent }, "Typed via Kimi vision", "success", { usedVision: true, elementTarget: target });
          await delay(300);
          return true;
        }
      } catch { /* vision failed */ }
    }
  }

  addAction(session, "type", { selector, text, intent }, "Input not found", "skipped");
  return false;
}

export async function typeAtFocus(
  session: LiveBrowserSession,
  text: string,
  opts?: { source?: "live_view" },
): Promise<void> {
  await session.page.keyboard.type(text, { delay: 50 });
  addLog(session, "info", `Typed text at focused element`);
  if (opts?.source === "live_view") {
    addAction(session, "type", { charCount: text.length, source: "live_view" }, "Typed from live view", "success");
  }
  await delay(200);
}

export async function pressKey(session: LiveBrowserSession, key: string): Promise<void> {
  await session.page.keyboard.press(key);
  addAction(session, "key", { key }, `Pressed ${key}`, "success");
  await delay(400);
}

export async function scroll(session: LiveBrowserSession, amount = 400): Promise<void> {
  await session.page.evaluate((amt) => window.scrollBy(0, amt), amount);
  await delay(300);
  addLog(session, "debug", `Scrolled down ${amount}px`);
}

export async function extract(session: LiveBrowserSession): Promise<{ url: string; text: string; html: string; sparse: boolean }> {
  const url = session.page.url();
  const html = await session.page.content().catch(() => "");
  const text = await session.page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const sparse = isSparseDom(html);
  addAction(session, "extract", { url }, `Extracted ${text.length} chars`, "success");
  return { url, text, html, sparse };
}

export async function waitForElement(session: LiveBrowserSession, selector: string, timeout = 10000): Promise<boolean> {
  try {
    await session.page.waitForSelector(selector, { timeout });
    return true;
  } catch { return false; }
}

/**
 * Pause execution and ask the user for input (e.g. to log in, confirm before sending).
 * The session goes into waitingForUser=true state. The frontend shows an overlay.
 * Resumes when the backend receives a /interact/resume call.
 */
export async function waitForUser(
  session: LiveBrowserSession,
  message: string,
  timeoutMs = 120000
): Promise<void> {
  session.waitingForUser = true;
  session.waitingMessage = message;
  addLog(session, "info", `⏸ Waiting for user: ${message}`);
  addAction(session, "wait_for_user", { message }, message, "success");

  const started = Date.now();
  while (session.waitingForUser && session.status === "running") {
    if (Date.now() - started > timeoutMs) {
      addLog(session, "warn", "Timed out waiting for user — continuing");
      session.waitingForUser = false;
      return;
    }
    await delay(500);
  }
}

export function resumeFromUser(session: LiveBrowserSession) {
  session.waitingForUser = false;
  session.waitingMessage = undefined;
  addLog(session, "info", "▶ User resumed session");
}

export async function wait(session: LiveBrowserSession, ms: number): Promise<void> {
  await delay(ms);
}

export async function closeBrowser(session: LiveBrowserSession): Promise<void> {
  session.status = "completed";
  if (session.screenshotInterval) clearInterval(session.screenshotInterval);
  session.frameListeners.clear();
  if (session.attachedViaCdp && session.cdpBrowser) {
    await session.page.close().catch(() => {});
    await session.cdpBrowser.close().catch(() => {});
    return;
  }
  await session.page.close().catch(() => {});
  await session.context.close().catch(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
