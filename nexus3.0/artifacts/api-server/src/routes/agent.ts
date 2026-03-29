import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import * as lb from "../services/live-browser.js";
import { runTask } from "../services/task-runner.js";
import { logger } from "../lib/logger.js";

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

export default router;
