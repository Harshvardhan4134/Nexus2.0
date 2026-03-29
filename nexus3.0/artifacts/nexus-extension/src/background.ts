/**
 * Service worker — popup runs tasks in the active tab; also long-polls the Nexus API
 * so sessions created from the Nexus web app run in real Chrome (no Playwright).
 */

import {
  BYOK_GROQ_STORAGE_KEY,
  BYOK_STORAGE_KEY,
} from "./application-profile";
import { NEXUS_FILL_FORM_FULL_TASK } from "./extension-constants";
import { generateEmailDraftWithGroq } from "./groq-email-draft";
import {
  buildLinkedInSearchUrl,
  linkedInJobTaskNeedsSearchNavigation,
} from "./linkedin-job-url";
import { extractHttpUrl, shouldNavigateFromChatToUrl } from "./navigate-from-chat";
import { isEmailIntent, isJobIntent } from "./task-intents";

function waitTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        resolve();
        return;
      }
      const onUpdated = (id: number, info: { status?: string }) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function ensureTabForTask(
  tabId: number,
  task: string,
  url: string | undefined,
): Promise<void> {
  const onGmail = url?.includes("mail.google.com") ?? false;

  if (isEmailIntent(task) && !onGmail) {
    await chrome.tabs.update(tabId, { url: "https://mail.google.com/mail/u/0/" });
    await waitTabComplete(tabId);
    await delay(600);
    return;
  }

  if (isJobIntent(task) && linkedInJobTaskNeedsSearchNavigation(url, task)) {
    await chrome.tabs.update(tabId, { url: buildLinkedInSearchUrl(task) });
    await waitTabComplete(tabId);
    await delay(1200);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** After tabs.update, wait until the tab reports an https URL (not blank / pending). */
async function waitForTabHttpUrl(tabId: number, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      const u = t.url ?? "";
      if (/^https?:\/\//i.test(u) && !u.startsWith("chrome-extension:")) {
        return;
      }
    } catch {
      return;
    }
    await delay(200);
  }
}

/** Pages where scripting API cannot inject (and manifest content_scripts do not run). */
function isNonInjectablePageUrl(url: string | undefined): string | null {
  if (!url || url === "") {
    return null;
  }
  const u = url.toLowerCase();
  if (
    u.startsWith("chrome:") ||
    u.startsWith("chrome-extension:") ||
    u.startsWith("edge:") ||
    u.startsWith("about:") ||
    u.startsWith("devtools:") ||
    u.startsWith("view-source:") ||
    u.startsWith("moz-extension:") ||
    u.startsWith("opera:")
  ) {
    return "Switch to a normal website tab (https://…). This page cannot run extension scripts (e.g. chrome:// or the built-in new tab).";
  }
  return null;
}

/**
 * Inject content script on demand. We only block known restricted schemes; if `tab.url` is missing
 * (rare API quirk), we still try `executeScript` and surface Chrome’s error if it fails.
 */
async function ensureContentScriptReady(tabId: number): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId);
  const blocked = isNonInjectablePageUrl(tab.url);
  if (blocked) {
    return blocked;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  await delay(200);
  return null;
}

async function getNexusApiConfig(): Promise<{ apiBase: string; secret: string }> {
  const sync = await chrome.storage.sync.get(["apiBaseUrl", "extensionSecret"]);
  const raw = typeof sync.apiBaseUrl === "string" ? sync.apiBaseUrl.trim() : "";
  const apiBase = raw ? raw.replace(/\/$/, "") : "http://127.0.0.1:8080";
  const secret = typeof sync.extensionSecret === "string" ? sync.extensionSecret.trim() : "";
  return { apiBase, secret };
}

function extensionHeaders(secret: string): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  if (secret) h["X-Nexus-Extension-Secret"] = secret;
  return h;
}

async function sendToContentWithRetry(
  tabId: number,
  message: { type: string; task: string },
  opts?: { maxAttempts?: number; backoffMs?: number },
): Promise<{ ok: boolean; result?: string; error?: string; url?: string }> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const backoffBase = opts?.backoffMs ?? 250;

  const injectErr = await ensureContentScriptReady(tabId);
  if (injectErr) {
    return { ok: false, error: injectErr };
  }

  let lastErr = "Unknown error";
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res && typeof res === "object") {
        return res as { ok: boolean; result?: string; error?: string; url?: string };
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (i === 0 && /Receiving end does not exist|Could not establish connection/i.test(lastErr)) {
        const again = await ensureContentScriptReady(tabId);
        if (again) {
          return { ok: false, error: again };
        }
      }
      await delay(backoffBase * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

/** Use lastFocusedWindow: MV3 service workers have no “current window”; currentWindow can pick the wrong tab. */
async function queryActiveUserTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function runTaskInActiveTab(
  taskText: string,
  /** Set by the popup so we target the browser tab that opened it (SW tab queries are unreliable). */
  explicitTabId?: number,
): Promise<{ ok: boolean; result?: string; error?: string; url?: string }> {
  let tabId: number;
  let urlForEnsure: string | undefined;

  if (explicitTabId !== undefined) {
    try {
      const t = await chrome.tabs.get(explicitTabId);
      tabId = explicitTabId;
      urlForEnsure = t.url;
    } catch {
      return { ok: false, error: "That tab is no longer open. Focus the site tab and try again." };
    }
  } else {
    const tab = await queryActiveUserTab();
    if (tab?.id === undefined) {
      return { ok: false, error: "No active tab" };
    }
    tabId = tab.id;
    urlForEnsure = tab.url;
  }

  const jobUrl = extractHttpUrl(taskText);
  if (jobUrl && shouldNavigateFromChatToUrl(taskText, jobUrl)) {
    await chrome.tabs.update(tabId, { url: jobUrl });
    await waitTabComplete(tabId);
    await waitForTabHttpUrl(tabId, 12_000);
    // SPAs (Workday, Greenhouse, etc.) often mount the form after first paint.
    await delay(4500);
    const useLinkedInFlow = isJobIntent(taskText) && /linkedin\.com\/jobs/i.test(jobUrl);
    const downstreamTask = useLinkedInFlow ? taskText : NEXUS_FILL_FORM_FULL_TASK;
    const res = await sendToContentWithRetry(
      tabId,
      { type: "EXECUTE_TASK", task: downstreamTask },
      { maxAttempts: 14, backoffMs: 350 },
    );
    if (res.ok && res.result) {
      return { ...res, result: `Opened target page. ${res.result}` };
    }
    return res;
  }

  await ensureTabForTask(tabId, taskText, urlForEnsure);
  await delay(150);
  return sendToContentWithRetry(tabId, { type: "EXECUTE_TASK", task: taskText });
}

async function postHeartbeat(apiBase: string, secret: string, sessionId: string, url: string): Promise<void> {
  try {
    await fetch(`${apiBase}/api/agent/extension/${sessionId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extensionHeaders(secret) },
      body: JSON.stringify({ url, message: `Tab URL: ${url}` }),
    });
  } catch {
    /* ignore */
  }
}

async function postComplete(
  apiBase: string,
  secret: string,
  sessionId: string,
  body: { success: boolean; summary?: string; url?: string; error?: string },
): Promise<void> {
  await fetch(`${apiBase}/api/agent/extension/${sessionId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extensionHeaders(secret) },
    body: JSON.stringify(body),
  });
}

async function pollServerForTasks(): Promise<void> {
  const { apiBase, secret } = await getNexusApiConfig();
  try {
    const r = await fetch(`${apiBase}/api/agent/extension/next?wait=50`, {
      headers: extensionHeaders(secret),
    });
    if (!r.ok) return;
    const data = (await r.json()) as { sessionId?: string; task?: string } | null;
    if (!data?.sessionId || !data?.task) return;

    const tab = await queryActiveUserTab();
    if (tab?.id !== undefined && tab.url) {
      void postHeartbeat(apiBase, secret, data.sessionId, tab.url);
    }

    const res = await runTaskInActiveTab(data.task);
    const tabAfter = await queryActiveUserTab();
    const finalUrl = res.url ?? tabAfter?.url;

    if (finalUrl) {
      void postHeartbeat(apiBase, secret, data.sessionId, finalUrl);
    }

    await postComplete(apiBase, secret, data.sessionId, {
      success: res.ok === true,
      summary: res.result ?? res.error ?? "",
      url: finalUrl,
      error: res.ok ? undefined : res.error,
    });
  } catch {
    /* network / API down */
  }
}

/**
 * MV3 service workers die if we idle between polls (e.g. setTimeout(1500)).
 * Chain .finally(step) so the next fetch starts in the same wake cycle — no gap.
 * Alarm is a backup if the chain ever stops.
 */
const BRIDGE_WAKE_ALARM = "nexusBridgeWake";

function startBridgeLoop(): void {
  const step = () => {
    void pollServerForTasks().finally(step);
  };
  step();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_WAKE_ALARM) {
    void pollServerForTasks();
  }
});

function ensureSidePanelOpensOnActionClick(): void {
  const sp = (
    chrome as typeof chrome & {
      sidePanel?: { setPanelBehavior: (o: { openPanelOnActionClick: boolean }) => Promise<void> };
    }
  ).sidePanel;
  if (sp?.setPanelBehavior) {
    void sp.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureSidePanelOpensOnActionClick();
  void chrome.alarms.create(BRIDGE_WAKE_ALARM, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  ensureSidePanelOpensOnActionClick();
  void chrome.alarms.create(BRIDGE_WAKE_ALARM, { periodInMinutes: 1 });
});

ensureSidePanelOpensOnActionClick();
void chrome.alarms.create(BRIDGE_WAKE_ALARM, { periodInMinutes: 1 });
startBridgeLoop();

chrome.runtime.onMessage.addListener(
  (
    msg: {
      type?: string;
      task?: string;
      tabId?: number;
      body?: string;
      to?: string;
      subject?: string;
    },
    _sender,
    sendResponse,
  ) => {
    if (msg?.type === "GENERATE_EMAIL_DRAFT") {
      void (async () => {
        try {
          const stored = await chrome.storage.local.get([BYOK_GROQ_STORAGE_KEY, BYOK_STORAGE_KEY]);
          const groq =
            typeof stored[BYOK_GROQ_STORAGE_KEY] === "string" ? stored[BYOK_GROQ_STORAGE_KEY].trim() : "";
          const legacy =
            typeof stored[BYOK_STORAGE_KEY] === "string" ? stored[BYOK_STORAGE_KEY].trim() : "";
          const apiKey = groq || legacy;
          if (!apiKey) {
            sendResponse({ ok: false, error: "no_groq_key" });
            return;
          }
          const subIn = typeof msg.subject === "string" ? msg.subject.trim() : "";
          const bodyIn = typeof msg.body === "string" ? msg.body.trim() : "";
          const draft = await generateEmailDraftWithGroq(apiKey, {
            task: typeof msg.task === "string" ? msg.task : "",
            to: typeof msg.to === "string" ? msg.to : undefined,
            subject: subIn || undefined,
            body: bodyIn || undefined,
          });
          const subject = subIn || draft.subject.trim();
          const body = bodyIn || draft.body.trim();
          if (!subject && !body) {
            sendResponse({ ok: false, error: "empty_draft" });
            return;
          }
          sendResponse({ ok: true, subject, body });
        } catch (e: unknown) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    if (msg?.type !== "RUN_TASK_FROM_POPUP" || typeof msg.task !== "string") {
      return;
    }
    const taskText = msg.task;
    const tabId = typeof msg.tabId === "number" ? msg.tabId : undefined;

    void runTaskInActiveTab(taskText, tabId)
      .then((res) => sendResponse(res))
      .catch((e: unknown) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );

    return true;
  },
);
