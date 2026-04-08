import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import * as lb from "../services/live-browser.js";
import { runTask } from "../services/task-runner.js";
import { runAutomation } from "../services/tinyfish.js";
import { logger } from "../lib/logger.js";
import pdfParse from "pdf-parse";

const router: IRouter = Router();

type LogEntry = { timestamp: string; level: lb.BrowserLog["level"]; message: string };

interface Session {
  id: string;
  task: string;
  status: "idle" | "running" | "waiting_for_user" | "completed" | "error" | "stopped";
  createdAt: string;
  model?: string;
  provider?: string;
  extractedData?: Record<string, unknown>;
  liveBrowser?: lb.LiveBrowserSession;
  /** True when task runs in the user's Chrome via the Nexus extension (no Playwright). */
  extensionMode?: boolean;
  extensionClaimed?: boolean;
  extensionLogs: LogEntry[];
  extensionUrl?: string;
}

const sessions = new Map<string, Session>();

function paramSessionId(req: Request): string | undefined {
  const sid = req.params.sessionId;
  const id = Array.isArray(sid) ? sid[0] : sid;
  return id || undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function checkExtensionSecret(req: Request, res: Response): boolean {
  const secret = process.env.NEXUS_EXTENSION_SECRET?.trim();
  if (!secret) return true;
  const h = req.headers["x-nexus-extension-secret"];
  if (h !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function session_log(session: Session, level: lb.BrowserLog["level"], message: string) {
  const entry: LogEntry = { timestamp: new Date().toISOString(), level, message };
  session.liveBrowser?.logs.push(entry);
  if (session.extensionMode) {
    session.extensionLogs.push(entry);
  }
}

const MODELS = [
  { id: "llama-3.1-70b-versatile", name: "Llama 3.1 70B", provider: "groq" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
];

router.get("/agent/models", (_req, res) => {
  res.json({ models: MODELS });
});

router.get("/agent/sessions", (_req, res) => {
  const sessionList = Array.from(sessions.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((s) => {
      const browser = s.liveBrowser;
      return {
        id: s.id,
        task: s.task,
        status: s.status,
        createdAt: s.createdAt,
        model: s.model,
        provider: s.provider,
        stepCount: browser?.actions.length ?? s.extensionLogs?.length ?? 0,
      };
    });
  res.json({ sessions: sessionList });
});

router.post("/agent/run", (req, res) => {
  const { task, model, provider, apiKey, kimiKey, useChromeExtension: bodyUseChrome } = req.body as {
    task: string;
    model?: string;
    provider?: string;
    apiKey?: string;
    kimiKey?: string;
    useChromeExtension?: boolean;
  };

  if (!task?.trim()) {
    res.status(400).json({ error: "task is required" });
    return;
  }

  const useChromeExtension =
    bodyUseChrome === true ||
    (process.env.NEXUS_USE_CHROME_EXTENSION === "1" && bodyUseChrome !== false);

  const id = randomUUID();

  const session: Session = {
    id,
    task,
    status: "running",
    createdAt: new Date().toISOString(),
    model: model ?? "browser",
    provider: useChromeExtension ? "chrome_extension" : (provider ?? "playwright"),
    extensionLogs: [],
  };

  sessions.set(id, session);

  if (useChromeExtension) {
    session.extensionMode = true;
    session_log(
      session,
      "info",
      "Task queued for your Chrome — ensure the Nexus extension is installed and bridge polling is running.",
    );
    res.json({
      sessionId: id,
      status: "running",
      extensionMode: true,
      message:
        "No Playwright session. The Nexus Chrome extension will claim this task when it polls the API.",
    });
    return;
  }

  const resolvedKimiKey = kimiKey || apiKey || process.env.KIMI_API_KEY;

  lb.launchLiveBrowser(id, { kimiKey: resolvedKimiKey })
    .then((browserSession) => {
      session.liveBrowser = browserSession;

      const syncStatus = setInterval(() => {
        if (!session.liveBrowser) {
          clearInterval(syncStatus);
          return;
        }
        const bs = session.liveBrowser;
        if (bs.waitingForUser) {
          session.status = "waiting_for_user";
        } else if (bs.status === "running" && session.status === "waiting_for_user") {
          session.status = "running";
        }
        if (bs.status === "completed" || bs.status === "error" || bs.status === "stopped") {
          clearInterval(syncStatus);
        }
      }, 300);

      return runTask(
        browserSession,
        task,
        resolvedKimiKey,
        (msg) => {
          session_log(session, "info", msg);
        },
        (msg) => {
          session_log(session, "warn", msg);
        },
      );
    })
    .then((result) => {
      if (session.status !== "stopped") {
        session.status = result.success ? "completed" : "error";
        session.extractedData = {
          summary: result.summary,
          url: result.url,
          timestamp: new Date().toISOString(),
        };
        if (session.liveBrowser) {
          session.liveBrowser.status = session.status === "completed" ? "completed" : "error";
        }
      }
    })
    .catch((err) => {
      logger.error({ err, sessionId: id }, "Browser task crashed");
      session.status = "error";
      if (session.liveBrowser) {
        session_log(session, "error", `Crashed: ${err instanceof Error ? err.message : String(err)}`);
        session.liveBrowser.status = "error";
        lb.closeBrowser(session.liveBrowser).catch(() => {});
      }
    });

  res.json({ sessionId: id, status: "running" });
});

router.get("/agent/extension/next", async (req, res) => {
  if (!checkExtensionSecret(req, res)) return;
  const waitSec = Math.min(parseInt(String(req.query.wait ?? "0"), 10) || 0, 55);
  const deadline = Date.now() + waitSec * 1000;

  do {
    const pending = [...sessions.values()].find(
      (s) => s.extensionMode && s.status === "running" && !s.extensionClaimed,
    );
    if (pending) {
      pending.extensionClaimed = true;
      session_log(pending, "info", "Task claimed by Chrome extension.");
      res.json({ sessionId: pending.id, task: pending.task });
      return;
    }
    if (waitSec === 0) break;
    await delay(400);
  } while (Date.now() < deadline);

  res.json(null);
});

router.post("/agent/extension/:sessionId/heartbeat", (req, res) => {
  if (!checkExtensionSecret(req, res)) return;
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session?.extensionMode) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { url, message } = req.body as { url?: string; message?: string };
  if (typeof url === "string") session.extensionUrl = url;
  if (typeof message === "string" && message.trim()) {
    session_log(session, "info", message.trim());
  }
  res.json({ ok: true });
});

router.post("/agent/extension/:sessionId/complete", (req, res) => {
  if (!checkExtensionSecret(req, res)) return;
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session?.extensionMode) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { success, summary, url, error } = req.body as {
    success?: boolean;
    summary?: string;
    url?: string;
    error?: string;
  };
  session.status = success === true ? "completed" : "error";
  if (typeof url === "string") session.extensionUrl = url;
  session.extractedData = {
    summary: summary ?? error ?? "",
    url: session.extensionUrl,
    timestamp: new Date().toISOString(),
  };
  if (error) session_log(session, "error", error);
  res.json({ ok: true });
});

router.get("/agent/sessions/:sessionId", (req, res) => {
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const browser = session.liveBrowser;
  const logs = session.extensionMode ? session.extensionLogs : (browser?.logs ?? []);
  res.json({
    id: session.id,
    task: session.task,
    status: session.status,
    createdAt: session.createdAt,
    model: session.model,
    stepCount: browser?.actions.length ?? session.extensionLogs.length,
    logs,
    actions: browser?.actions ?? [],
    extractedData: session.extractedData,
    currentUrl: session.extensionUrl ?? browser?.currentUrl,
    waitingForUser: browser?.waitingForUser ?? false,
    waitingMessage: browser?.waitingMessage,
    browserSurface: browser?.browserSurface ?? "headless",
    extensionMode: session.extensionMode ?? false,
  });
});

/**
 * SSE — streams live screenshots + status updates.
 */
router.get("/agent/sessions/:sessionId/stream", (req: Request, res: Response) => {
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (session.extensionMode) {
    send("status", {
      status: session.status,
      extensionMode: true,
      currentUrl: session.extensionUrl,
      logs: session.extensionLogs.slice(-12),
    });
    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* gone */
      }
    }, 15000);
    const statusInterval = setInterval(() => {
      send("status", {
        status: session.status,
        extensionMode: true,
        currentUrl: session.extensionUrl,
        logs: session.extensionLogs.slice(-12),
      });
      if (["completed", "error", "stopped"].includes(session.status)) {
        clearInterval(statusInterval);
        clearInterval(keepalive);
        res.end();
      }
    }, 800);
    req.on("close", () => {
      clearInterval(statusInterval);
      clearInterval(keepalive);
    });
    return;
  }

  send("status", {
    status: session.status,
    waitingForUser: session.liveBrowser?.waitingForUser ?? false,
    waitingMessage: session.liveBrowser?.waitingMessage,
  });

  let unsubscribe: (() => void) | undefined;
  let statusInterval: ReturnType<typeof setInterval> | undefined;
  let attachTimeout: ReturnType<typeof setTimeout> | undefined;

  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* client gone */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(keepalive);
    if (statusInterval) clearInterval(statusInterval);
    if (attachTimeout) clearTimeout(attachTimeout);
    unsubscribe?.();
  };

  req.on("close", cleanup);

  const attachListener = () => {
    if (!session.liveBrowser) {
      if (["completed", "error", "stopped"].includes(session.status)) {
        send("status", { status: session.status });
        res.end();
        return;
      }
      attachTimeout = setTimeout(attachListener, 200);
      return;
    }

    unsubscribe = lb.addFrameListener(session.liveBrowser, (frame) => {
      send("frame", frame);
    });

    statusInterval = setInterval(() => {
      const browser = session.liveBrowser;
      send("status", {
        status: session.status,
        waitingForUser: browser?.waitingForUser ?? false,
        waitingMessage: browser?.waitingMessage,
        logs: browser?.logs.slice(-5) ?? [],
        actions: browser?.actions.slice(-3) ?? [],
      });
      if (["completed", "error", "stopped"].includes(session.status)) {
        cleanup();
        res.end();
      }
    }, 800);
  };

  attachListener();
});

router.post("/agent/sessions/:sessionId/interact/click", async (req, res) => {
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session?.liveBrowser) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { x, y } = req.body as { x: number; y: number };
  if (typeof x !== "number" || typeof y !== "number") {
    res.status(400).json({ error: "x and y are required" });
    return;
  }
  try {
    await lb.clickCoordinates(session.liveBrowser, x, y);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/agent/sessions/:sessionId/interact/key", async (req, res) => {
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session?.liveBrowser) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { text, key } = req.body as { text?: string; key?: string };
  try {
    if (text) await lb.typeAtFocus(session.liveBrowser, text, { source: "live_view" });
    if (key) await lb.pressKey(session.liveBrowser, key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/agent/sessions/:sessionId/resume", (req, res) => {
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session?.liveBrowser) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  lb.resumeFromUser(session.liveBrowser);
  session.status = "running";
  res.json({ success: true, message: "Session resumed" });
});

router.post("/agent/sessions/:sessionId/stop", (req, res) => {
  const sessionId = paramSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  session.status = "stopped";
  if (session.liveBrowser) {
    session.liveBrowser.status = "stopped";
    lb.closeBrowser(session.liveBrowser).catch(() => {});
  }
  res.json({ success: true });
});

// ─── TinyFish supervised automation ───────────────────────────────────────────

interface TinyFishRun {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed";
  streamingUrl?: string;
  logs: string[];
  result: Record<string, unknown> | null;
  error?: string;
  resultUrl?: string;
  createdAt: string;
}

const tfRuns = new Map<string, TinyFishRun>();

/** Extract plain text from a base64-encoded PDF or plain-text file. */
async function extractResumeText(base64: string, mime: string): Promise<{ text: string; error?: string }> {
  try {
    const buffer = Buffer.from(base64, "base64");
    if (mime === "text/plain") {
      return { text: buffer.toString("utf-8").slice(0, 3000) };
    }
    // Use require() so pdf-parse loads from node_modules with correct paths
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParseLib = (globalThis as Record<string, unknown>).require?.("pdf-parse") as typeof pdfParse ?? pdfParse;
    const result = await pdfParseLib(buffer, { max: 0 });
    const text = (result.text ?? "").replace(/\s+/g, " ").trim().slice(0, 3000);
    logger.info({ bytes: buffer.length, chars: text.length }, "PDF text extracted");
    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "PDF extraction failed");
    return { text: "", error: msg };
  }
}

/** POST /api/resume/extract — decode a base64 resume and return extracted text. */
router.post("/resume/extract", (req, res) => {
  const { base64, mime } = req.body as { base64?: string; mime?: string };
  if (!base64) {
    res.status(400).json({ error: "base64 is required" });
    return;
  }
  void extractResumeText(base64, mime ?? "application/pdf").then(({ text, error }) => {
    res.json({ text, error });
  });
});

function buildTfGoal(task: string, email: string, password: string, extra?: Record<string, unknown>): string {
  const t = task.trim();
  const creds = email
    ? `Log in with email "${email}" and password "${password}" if asked. If a 2-step verification or phone approval prompt appears, wait up to 90 seconds for the user to approve it on their device before continuing — do not skip or bypass it.`
    : "If a login is required, stop and report that credentials are needed.";

  // Direct form URL provided — fill and submit using profile data
  const formUrl = (extra?.formUrl as string | undefined) ?? "";
  if (formUrl) {
    const profileHint = (extra?.profile as string | undefined) ?? "";
    const resumeHint = (extra?.hasResume as boolean | undefined)
      ? "A resume has been uploaded — attach or use it if the form has a resume/CV upload field."
      : "";

    const isMsForm = /forms\.office\.com|forms\.microsoft\.com/i.test(formUrl);
    const isGoogleForm = /docs\.google\.com\/forms|forms\.gle/i.test(formUrl);
    const isTypeform = /typeform\.com/i.test(formUrl);

    // Profile block — labeled lines so TinyFish maps each value to the right field
    const profileBlock = profileHint.trim()
      ? `USE ONLY THIS DATA (no invented values):\n${profileHint}`
      : `(No applicant data provided — leave unknown fields blank.)`;

    let platformInstructions: string;

    if (isMsForm) {
      const loginStep = email
        ? `If a Microsoft sign-in page appears, sign in with email "${email}" and password "${password}". Click "Stay signed in" → Yes. Then navigate back to ${formUrl}.`
        : `If a Microsoft sign-in page appears, look for "Continue as guest" or "Submit anonymously". If none, skip sign-in.`;
      platformInstructions = [
        `First navigate to https://www.bing.com, wait 2 seconds, then navigate to ${formUrl}. This avoids bot detection.`,
        loginStep,
        `Once the form is loaded, start filling it immediately — work top-to-bottom through every visible question:`,
        `Text/paragraph fields → click and type the value from the data above.`,
        `Choice/radio → click the option closest to the data.`,
        `Checkbox → check all that apply.`,
        `Dropdown → click and select the best match.`,
        `Rating/Likert → click the appropriate number/star.`,
        `Date → click the date picker and enter the date.`,
        `After all questions are answered, click "Next" (if multi-page) or "Submit". Repeat per page.`,
        `Report the confirmation message shown after submission.`,
      ].join(" ");
    } else if (isGoogleForm) {
      platformInstructions = [
        `The Google Form at ${formUrl} is already open. Fill it NOW — do NOT navigate away.`,
        `Work top-to-bottom: short answer/paragraph → click and type; multiple choice → click radio; checkboxes → check all that apply; dropdown → select best match; linear scale → click the number.`,
        `Click "Next" between sections and "Submit" at the end.`,
        `Report the "Your response has been recorded" confirmation.`,
      ].join(" ");
    } else if (isTypeform) {
      platformInstructions = [
        `The Typeform at ${formUrl} is already open. Fill it NOW — do NOT navigate away.`,
        `Typeform shows one question at a time. Type the answer (then press Enter/OK) or click the matching option. Continue until the Submit button appears and click it.`,
        `Report the thank-you confirmation message.`,
      ].join(" ");
    } else {
      platformInstructions = [
        `The form at ${formUrl} is already open. Fill it NOW — do NOT navigate away.`,
        `Click each field and fill it with the data provided (type for text, select for dropdowns, click for checkboxes/radio). Click Next/Continue between pages, then Submit.`,
        `Report any confirmation message shown after submission.`,
        email ? `If login is required: ${creds}` : "",
      ].filter(Boolean).join(" ");
    }

    // Rules come FIRST so TinyFish reads them before planning anything
    const hardRules = [
      `⛔ STOP — read these rules before doing ANYTHING:`,
      `Rule 1: The form is already open at ${formUrl}. Do NOT visit Google, Bing, or any search engine.`,
      `Rule 2: Use ONLY the data listed below. Do NOT invent placeholder values ("John Doe", "example@email.com", "9876543210", etc.).`,
      `Rule 3: Do NOT enter payment card numbers or bank details.`,
      `Rule 4: If a field has no matching data below, leave it blank — do not guess.`,
    ].join(" ");

    return [
      hardRules,
      profileBlock,
      resumeHint,
      platformInstructions,
    ].filter(Boolean).join("\n\n");
  }

  if (/linkedin/i.test(t)) {
    const profileHint = (extra?.profile as string | undefined) ?? "";
    const resumeHint = (extra?.hasResume as boolean | undefined)
      ? "Upload the resume when prompted."
      : "";
    const isCaptchaRetry = Boolean(extra?.captchaRetry);

    const applySteps = [
      `1. Click the first relevant job card in the list.`,
      `2. Click "Easy Apply" immediately — do NOT click any other button.`,
      `3. Fill every form field step by step. For any unclear question, choose the most reasonable default.`,
      profileHint ? `Applicant info: ${profileHint}.` : "",
      resumeHint,
      `4. Submit the application.`,
      `5. Return: job title, company name, and the job URL.`,
      `Skip any job that only has an "Apply" (external) button — move to the next job.`,
      `Do not spend more than 3 minutes on a single application.`,
    ].filter(Boolean);

    if (isCaptchaRetry) {
      return [
        `You are on a Google search results page. ${creds}`,
        `Click the first LinkedIn Jobs search result link to go to LinkedIn.`,
        `Once on LinkedIn, if asked to log in: ${creds}`,
        `Then apply to the first Easy Apply job posting:`,
        ...applySteps,
      ].filter(Boolean).join(" ");
    }

    return [
      `You are already on a LinkedIn Easy Apply jobs search results page. ${creds}`,
      `Goal: Apply to the first suitable job posting visible in the results.`,
      ...applySteps,
    ].filter(Boolean).join(" ");
  }

  // Swiggy food ordering
  if (/swiggy/i.test(t) || (/order\s+(food|pizza|biryani|burger|lunch|dinner|breakfast|meal|sushi|noodles)/i.test(t) && !/zomato/i.test(t))) {
    const profileRaw = (extra?.profile as string | undefined) ?? "";
    const addressHint = profileRaw ? `Use this delivery address from my profile: ${profileRaw}.` : "";

    // Extract food item from task
    const foodMatch = t.match(/order\s+(?:(?:a|some|the)\s+)?([\w\s]+?)(?:\s+(?:from|on|via|using|at)\b|$)/i);
    const foodItem = foodMatch ? foodMatch[1].trim() : "";

    return [
      `Go to https://www.swiggy.com. ${creds}`,
      `Task: Order ${foodItem || "popular food (choose something quick and highly rated)"} for delivery.`,
      `Steps:`,
      `1. If asked to set a delivery location, use the address from my profile or allow location detection.`,
      `${addressHint}`,
      `2. Search for the food item or a restaurant that serves it.`,
      `3. Pick the first well-rated option. Add the item to cart.`,
      `4. Proceed to checkout. Select "Cash on Delivery" (COD) as the payment method — do NOT enter card details.`,
      `5. Confirm and place the order.`,
      `6. Return the order confirmation details: restaurant name, items ordered, estimated delivery time.`,
      `If login is required: ${creds}`,
    ].filter(Boolean).join(" ");
  }

  // Zomato food ordering
  if (/zomato/i.test(t)) {
    const profileRaw = (extra?.profile as string | undefined) ?? "";
    const addressHint = profileRaw ? `Use this delivery address from my profile: ${profileRaw}.` : "";

    const foodMatch = t.match(/order\s+(?:(?:a|some|the)\s+)?([\w\s]+?)(?:\s+(?:from|on|via|using|at)\b|$)/i);
    const foodItem = foodMatch ? foodMatch[1].trim() : "";

    return [
      `Go to https://www.zomato.com. ${creds}`,
      `Task: Order ${foodItem || "popular food (choose something quick and highly rated)"} for delivery.`,
      `Steps:`,
      `1. If asked to set a delivery location, use the address from my profile or allow location detection.`,
      `${addressHint}`,
      `2. Search for the food item or a restaurant that serves it.`,
      `3. Pick the first well-rated option. Add the item to cart.`,
      `4. Proceed to checkout. Select "Cash on Delivery" (COD) as the payment method — do NOT enter card details.`,
      `5. Confirm and place the order.`,
      `6. Return the order confirmation details: restaurant name, items ordered, estimated delivery time.`,
      `If login is required: ${creds}`,
    ].filter(Boolean).join(" ");
  }

  // Gmail search / find
  if (/(search|find|look\s*for|open|check)\s+(my\s+)?(gmail|mail|email|inbox)/i.test(t)) {
    const query = t
      .replace(/(search|find|look\s+for|open|check)\s+(my\s+)?(gmail|mail|email|inbox)\s*(for\s*)?/i, "")
      .trim();
    return `Go to https://mail.google.com. ${creds} Search Gmail for "${query || t}". Return the URL of any matching email you find and a one-sentence summary of what it contains.`;
  }

  // Gmail compose / send / write / draft
  if (/send|compose|write|draft/i.test(t)) {
    return [
      `Go to https://mail.google.com. ${creds}`,
      `Click "Compose" to open a new email window.`,
      `Based on the following request, figure out the recipient, subject, and body yourself — write a professional, concise email:`,
      `"${t}"`,
      `Fill in the To field, Subject field, and body. Then click Send.`,
      `Return a confirmation of what you sent and to whom.`,
    ].join(" ");
  }

  // Gmail formalize
  if (/formal|professional|polish|improve/i.test(t)) {
    return `Go to https://mail.google.com. ${creds} Open the draft or email in question. Rewrite the body to be more formal and professional. Return the improved text.`;
  }

  // Generic Gmail task
  if (/gmail|mail|email|inbox/i.test(t)) {
    return `Go to https://mail.google.com. ${creds} Task: ${t}. Return what you did and any relevant URLs.`;
  }

  return `${creds} Task: ${t}. Return what you accomplished and any relevant URLs.`;
}

function getTfStartUrl(task: string, captchaRetry = false): string {
  if (/linkedin/i.test(task)) {
    if (captchaRetry) {
      const role = extractLinkedInRole(task);
      const location = extractLinkedInLocation(task);
      const q = encodeURIComponent(`linkedin easy apply jobs${role ? " " + role : ""}${location ? " " + location : ""}`);
      return `https://www.google.com/search?q=${q}`;
    }
    return buildLinkedInSearchUrl(task);
  }
  if (/swiggy/i.test(task)) return "https://www.swiggy.com";
  if (/zomato/i.test(task)) return "https://www.zomato.com";
  if (/order\s+(food|pizza|biryani|burger|lunch|dinner|breakfast|meal)/i.test(task)) return "https://www.swiggy.com";
  if (/gmail|mail|email/i.test(task)) return "https://mail.google.com";
  return "https://google.com";
}

/** Extract job role keywords from a task string. */
function extractLinkedInRole(task: string): string {
  const t = task.trim();
  const m =
    t.match(/apply\s+(?:for\s+)?(?:a\s+)?(.+?)\s+(?:job|position|role|opening)/i) ||
    t.match(/(?:find|search|look\s+for)\s+(?:a\s+)?(.+?)\s+(?:job|position|role)/i) ||
    t.match(/apply\s+(?:for\s+)?([\w\s]+?)(?:\s+in\s+|\s+at\s+|\s+on\s+linkedin|$)/i);
  return m ? m[1].trim() : "";
}

/** Extract location from a task string. */
function extractLinkedInLocation(task: string): string {
  const t = task.trim();
  const m =
    t.match(/\bin\s+([\w\s,]+?)(?:\s+on\s+linkedin|$)/i) ||
    t.match(/\bnear\s+([\w\s,]+?)(?:\s+on\s+linkedin|$)/i);
  return m ? m[1].trim() : "";
}

/** Build a LinkedIn jobs search URL with Easy Apply filter pre-applied to skip navigation steps. */
function buildLinkedInSearchUrl(task: string): string {
  const rawKeywords = extractLinkedInRole(task);
  const rawLocation = extractLinkedInLocation(task);

  const params = new URLSearchParams();
  if (rawKeywords) params.set("keywords", rawKeywords);
  if (rawLocation) params.set("location", rawLocation);
  params.set("f_AL", "true"); // Easy Apply filter
  params.set("sortBy", "R");  // Most recent

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/** POST /api/tinyfish/run — start a TinyFish cloud automation. Returns immediately with runId. */
router.post("/tinyfish/run", (req, res) => {
  const { task, email, password, apiKey, profile, hasResume, captchaRetry, formUrl } = req.body as {
    task?: string;
    email?: string;
    password?: string;
    apiKey?: string;
    profile?: string;
    hasResume?: boolean;
    captchaRetry?: boolean;
    formUrl?: string;
  };

  if (!task?.trim()) {
    res.status(400).json({ error: "task is required" });
    return;
  }

  const tfKey = (apiKey?.trim()) || process.env.TINYFISH_API_KEY?.trim();
  if (!tfKey) {
    res.status(400).json({ error: "no_tinyfish_key" });
    return;
  }

  const runId = randomUUID();
  const run: TinyFishRun = {
    runId,
    task: task.trim(),
    status: "running",
    logs: [],
    result: null,
    createdAt: new Date().toISOString(),
  };
  tfRuns.set(runId, run);

  const goal = buildTfGoal(task, email?.trim() ?? "", password?.trim() ?? "", { profile: profile ?? "", hasResume, captchaRetry, formUrl });
  // For Microsoft Forms start at Bing to warm up the browser session before hitting the form
  const isMsFormUrl = /forms\.office\.com|forms\.microsoft\.com/i.test(formUrl ?? "");
  const startUrl = formUrl?.trim()
    ? (isMsFormUrl ? "https://www.bing.com" : formUrl.trim())
    : getTfStartUrl(task, Boolean(captchaRetry));

  logger.info({ runId, startUrl, goalPreview: goal.slice(0, 400) }, "Starting TinyFish run");

  void runAutomation(
    { apiKey: tfKey },
    {
      url: startUrl,
      goal,
      browserProfile: "stealth",
      onStreamingUrl: (url) => {
        run.streamingUrl = url;
        logger.info({ runId, url }, "TinyFish streaming URL received");
      },
      onProgress: (msg) => {
        run.logs.push(msg);
      },
    },
  )
    .then((result) => {
      run.status = result.status === "COMPLETED" ? "completed" : "failed";
      run.result = result.result ?? null;
      run.error = result.error;
      if (!run.streamingUrl && result.streamingUrl) run.streamingUrl = result.streamingUrl;

      const r = result.result as Record<string, unknown> | null;
      if (r) {
        const candidate = r["url"] ?? r["link"] ?? r["current_url"] ?? r["page_url"];
        if (typeof candidate === "string" && candidate.startsWith("http")) {
          run.resultUrl = candidate;
        }
      }
      if (!run.resultUrl) {
        // Skip TinyFish streaming URLs and generic homepages (mail.google.com, linkedin.com, google.com)
        const isUselessUrl = (u: string) =>
          /tinyfish\.io|tetra-data\.production/i.test(u) ||
          /^https?:\/\/(mail\.google\.com|www\.linkedin\.com|linkedin\.com|www\.google\.com|google\.com)\/?$/i.test(u);
        const urlMatch = run.logs
          .slice()
          .reverse()
          .map((l) => l.match(/https?:\/\/[^\s"']+/)?.[0])
          .find((u) => u && !isUselessUrl(u));
        if (urlMatch) run.resultUrl = urlMatch;
      }

      logger.info({ runId, status: run.status, resultUrl: run.resultUrl }, "TinyFish run finished");
    })
    .catch((err) => {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      logger.error({ runId, err }, "TinyFish run error");
    });

  res.json({ runId, status: "running" });
});

/** GET /api/tinyfish/:runId/status — poll for live status, logs, streamingUrl, result. */
router.get("/tinyfish/:runId/status", (req, res) => {
  const run = tfRuns.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    runId: run.runId,
    status: run.status,
    streamingUrl: run.streamingUrl,
    logs: run.logs,
    result: run.result,
    resultUrl: run.resultUrl,
    error: run.error,
  });
});

export default router;
