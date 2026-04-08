/**
 * Task Runner — interprets free-text tasks and executes them in the live browser.
 *
 * Supports:
 *  - Email: "send an email to john@example.com saying..."  → Gmail
 *  - Jobs: "apply for a software engineer job at Google"   → LinkedIn Easy Apply
 *  - Search: "find X" / "look up X"                       → DuckDuckGo
 *  - GitHub, YouTube, Wikipedia, LinkedIn, Amazon, Reddit, DoorDash, Travel
 *
 * Auto actions (opt out with env):
 *  - NEXUS_AUTO_SEND_EMAIL=0 — skip Gmail auto-send after compose (default: auto-send on)
 *  - NEXUS_AUTO_LINKEDIN_APPLY=0 — skip LinkedIn Easy Apply wizard (default: auto-advance on)
 */

import type { Page } from "playwright";
import * as lb from "./live-browser.js";
import { runAutomation } from "./tinyfish.js";

const autoSendEmail = process.env.NEXUS_AUTO_SEND_EMAIL !== "0";
const autoLinkedInApply = process.env.NEXUS_AUTO_LINKEDIN_APPLY !== "0";

// ─── AI Email Generation (OpenRouter) ─────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o-mini";

interface AiEmailDraft { subject: string; body: string }

async function generateEmailWithAI(task: string, to?: string): Promise<AiEmailDraft | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;

  const model = process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL;
  const system = `You compose professional emails. Reply ONLY with a JSON object with two keys: "subject" (one line) and "body" (plain text, use \\n for new lines).`;
  const user = [
    `Write an email for this request: ${task.trim()}`,
    to ? `Recipient email: ${to}` : "",
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nexus-agent.local",
        "X-Title": "Nexus Agent (API server)",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1024,
        temperature: 0.45,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };
    return {
      subject: (parsed.subject ?? "").trim(),
      body: (parsed.body ?? "").replace(/\\n/g, "\n").trim(),
    };
  } catch {
    return null;
  }
}

export interface TaskRunnerResult {
  success: boolean;
  summary: string;
  url?: string;
  extractedData?: string;
}

interface TaskIntent {
  type: "email" | "job" | "github" | "youtube" | "wikipedia" | "linkedin" |
        "amazon" | "reddit" | "doordash" | "travel" | "search";
  raw: string;
  email?: { to?: string; subject?: string; body?: string };
  job?: { title?: string; company?: string; location?: string; site?: string };
  query?: string;
}

// ─── Intent Parser ───────────────────────────────────────────────────────────

function parseIntent(task: string): TaskIntent {
  const t = task.toLowerCase().trim();

  // Email intent
  const emailPatterns = [
    /send\s+(a\s+)?mail/i,
    /send\s+(an?\s+)?email/i,
    /compose\s+(a\s+)?mail/i,
    /write\s+(an?\s+)?email/i,
    /email\s+someone/i,
  ];
  if (emailPatterns.some((p) => p.test(task))) {
    const toMatch = task.match(/to\s+([\w.+-]+@[\w.-]+\.\w+)/i);
    const emailTo = toMatch?.[1];
    const subjectMatch = task.match(/(?:subject|about|regarding|re:?)\s+["""']?([^"""']+)["""']?/i);
    const bodyMatch = task.match(/(?:saying|message|body|content|text)\s+["""']?([^"""']{5,})["""']?/i);
    const freeText = task.replace(/send\s+(a\s+)?mail\s*(to\s+[\w.+-]+@[\w.-]+\.\w+)?\s*/i, "").trim();
    return {
      type: "email",
      raw: task,
      email: {
        to: emailTo,
        subject: subjectMatch?.[1]?.trim(),
        body: bodyMatch?.[1]?.trim() ?? freeText,
      },
    };
  }

  // Job application intent
  const jobPatterns = [
    /apply\s+(for\s+)?(a\s+)?job/i,
    /job\s+application/i,
    /apply\s+on\s+linkedin/i,
    /apply\s+on\s+indeed/i,
    /submit\s+(a\s+)?resume/i,
    /search\s+(for\s+)?jobs?/i,
    /find\s+(me\s+)?jobs?/i,
    /look\s+for\s+jobs?/i,
  ];
  if (jobPatterns.some((p) => p.test(task))) {
    const titleMatch = task.match(/(?:for\s+(?:a\s+)?)?([a-z][a-z\s]+?)\s+(?:job|role|position)/i);
    const companyMatch = task.match(/(?:at|@)\s+([A-Za-z][A-Za-z0-9\s]+)/i);
    const locationMatch = task.match(/(?:in|at)\s+([A-Za-z][A-Za-z\s,]+)/i);
    const siteMatch = /indeed/i.test(task) ? "indeed" : /glassdoor/i.test(task) ? "glassdoor" : "linkedin";
    return {
      type: "job",
      raw: task,
      job: {
        title: titleMatch?.[1]?.trim() ?? deriveSearchQuery(task),
        company: companyMatch?.[1]?.trim(),
        location: locationMatch?.[1]?.trim(),
        site: siteMatch,
      },
    };
  }

  // Site-specific routing
  if (/github/i.test(t)) return { type: "github", raw: task, query: deriveSearchQuery(task) };
  if (/youtube|watch|video/i.test(t)) return { type: "youtube", raw: task, query: deriveSearchQuery(task) };
  if (/wikipedia|wiki/i.test(t)) return { type: "wikipedia", raw: task, query: deriveSearchQuery(task) };
  if (/linkedin/i.test(t) && !jobPatterns.some((p) => p.test(task))) return { type: "linkedin", raw: task, query: deriveSearchQuery(task) };
  if (/amazon/i.test(t)) return { type: "amazon", raw: task, query: deriveSearchQuery(task) };
  if (/reddit/i.test(t)) return { type: "reddit", raw: task, query: deriveSearchQuery(task) };
  if (/doordash|food delivery|order food/i.test(t)) return { type: "doordash", raw: task, query: deriveSearchQuery(task) };
  if (/flight|hotel|travel|trip|book.*(?:plane|flight|hotel)/i.test(t)) return { type: "travel", raw: task, query: deriveSearchQuery(task) };

  return { type: "search", raw: task, query: deriveSearchQuery(task) };
}

function deriveSearchQuery(task: string): string {
  return task
    .replace(/^(search\s+(for\s+)?|find\s+(me\s+)?|look\s+up\s+|google\s+|browse\s+)/i, "")
    .trim();
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runTask(
  session: lb.LiveBrowserSession,
  task: string,
  kimiKey: string | undefined,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<TaskRunnerResult> {
  const intent = parseIntent(task);
  switch (intent.type) {
    case "email":    return runEmail(session, intent, log, warn);
    case "job":      return runJob(session, intent, log, warn);
    case "github":   return runGitHub(session, task, kimiKey, log, warn);
    case "youtube":  return runYouTube(session, task, log);
    case "wikipedia":return runWikipedia(session, task, log);
    case "linkedin": return runLinkedIn(session, task, log);
    case "amazon":   return runAmazon(session, task, kimiKey, log);
    case "reddit":   return runReddit(session, task, kimiKey, log, warn);
    case "doordash": return runDoorDash(session, task, log);
    case "travel":   return runTravel(session, task, log);
    default:         return runDuckDuckGoSearch(session, task, log);
  }
}

function done(
  session: lb.LiveBrowserSession,
  success: boolean,
  summary: string,
  url?: string,
  extractedData?: string
): TaskRunnerResult {
  return { success, summary, url: url ?? session.currentUrl, extractedData };
}

/** Try to click Gmail Send after compose (selectors vary by Gmail build). */
async function tryClickGmailSend(
  session: lb.LiveBrowserSession,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<boolean> {
  const page = session.page;
  const selectors = [
    '[data-tooltip="Send"]',
    '[data-tooltip*="Send"]',
    'div[role="button"][aria-label^="Send"]',
    'div[aria-label="Send"]',
    'div[role="button"][data-tooltip*="Send"]',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: 4000 });
      await loc.click({ timeout: 4000 });
      await lb.wait(session, 2000);
      log("Send button clicked.");
      return true;
    } catch {
      /* try next selector */
    }
  }
  warn("Could not auto-click Gmail Send (UI may have changed).");
  return false;
}

/** Advance LinkedIn Easy Apply: Next / Review / Submit until done or stuck. */
async function tryAdvanceLinkedInEasyApply(
  session: lb.LiveBrowserSession,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<void> {
  const page: Page = session.page;
  const maxSteps = 25;

  for (let step = 0; step < maxSteps; step++) {
    await lb.wait(session, 900);

    const submitted = await page
      .getByText(/Application submitted|submitted your application|You applied|Your application was sent/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (submitted) {
      log("LinkedIn reports application submitted.");
      return;
    }

    const primaryClicked = await tryClickLinkedInEasyApplyPrimary(page, session);
    if (primaryClicked) {
      log(`Easy Apply step ${step + 1}…`);
      continue;
    }

    warn("Auto-apply could not find Next/Submit; pausing for manual steps.");
    await lb.waitForUser(
      session,
      "Complete any remaining fields and submit the application, then click Resume here when done",
    );
    return;
  }

  warn("Stopped after max Easy Apply steps.");
  await lb.waitForUser(
    session,
    "Finish the application if needed, then click Resume here when done",
  );
}

async function tryClickLinkedInEasyApplyPrimary(
  page: Page,
  session: lb.LiveBrowserSession,
): Promise<boolean> {
  const candidates = [
    page.locator('button[data-easy-apply-next-button]').first(),
    page.getByRole("button", { name: /^Next$/i }).first(),
    page.getByRole("button", { name: /Continue to next step/i }).first(),
    page.getByRole("button", { name: /^Review$/i }).first(),
    page.getByRole("button", { name: /Submit application/i }).first(),
    page.locator(".jobs-easy-apply-footer button.artdeco-button--primary").first(),
    page.locator('button.artdeco-button--primary:has-text("Next")').first(),
    page.locator('button.artdeco-button--primary:has-text("Submit")').first(),
  ];

  for (const loc of candidates) {
    try {
      if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) continue;
      if (await loc.isDisabled().catch(() => false)) continue;
      await loc.click({ timeout: 5000 });
      await lb.wait(session, 1200);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

// ─── Email via Gmail ──────────────────────────────────────────────────────────

/** Inbox URL avoids workspace.google.com marketing redirect from bare mail.google.com */
const GMAIL_INBOX_URL = "https://mail.google.com/mail/u/0/";

function isGmailAppUrl(url: string): boolean {
  return /mail\.google\.com\/mail\//.test(url);
}

async function fillGmailToField(
  session: lb.LiveBrowserSession,
  to: string,
  log: (m: string) => void,
): Promise<void> {
  const page = session.page;
  log(`Filling recipient: ${to}`);

  const toSelectors = [
    'textarea[name="to"]',
    'input[name="to"]',
    '[aria-label="To recipients"]',
    '[aria-label*="To"]',
    'input[aria-autocomplete="list"]',
  ];

  for (const sel of toSelectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: 3000 });
      await loc.click({ timeout: 2000 });
      await lb.wait(session, 150);
      await page.keyboard.type(to, { delay: 35 });
      await lb.wait(session, 600);
      await page.keyboard.press("Enter");
      await lb.wait(session, 600);
      log(`Recipient entered via: ${sel}`);
      return;
    } catch {
      /* try next selector */
    }
  }
  // Fallback: click the To row by position
  log("To selectors failed — typing via keyboard as last resort");
  await page.keyboard.type(to, { delay: 35 });
  await lb.wait(session, 500);
  await page.keyboard.press("Enter");
  await lb.wait(session, 400);
}

async function runEmail(
  session: lb.LiveBrowserSession,
  intent: TaskIntent,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<TaskRunnerResult> {
  let { to, subject, body } = intent.email ?? {};
  log("Opening Gmail...");
  await lb.navigate(session, GMAIL_INBOX_URL);
  await lb.wait(session, 3000);

  let url = session.currentUrl;
  let isLoggedIn =
    isGmailAppUrl(url) && !url.includes("accounts.google.com");

  // Bare mail.google.com often lands on Workspace marketing; force the real app
  if (
    url.includes("workspace.google.com") ||
    (url.includes("mail.google.com") && !isGmailAppUrl(url))
  ) {
    log("Navigating to Gmail inbox (app)…");
    await lb.navigate(session, GMAIL_INBOX_URL);
    await lb.wait(session, 2500);
    url = session.currentUrl;
    isLoggedIn =
      isGmailAppUrl(url) && !url.includes("accounts.google.com");
  }

  if (!isLoggedIn) {
    log("Gmail needs you to log in first...");
    warn("Not logged in to Gmail. Please log in in the browser below.");
    await lb.waitForUser(session, "Please log in to Gmail in the browser below, then click Resume");
    await lb.wait(session, 2000);
    await lb.navigate(session, GMAIL_INBOX_URL);
    await lb.wait(session, 3000);
  }

  // AI generation — fill in missing subject/body
  const needsAi = !subject?.trim() || !body?.trim();
  if (needsAi) {
    log("Generating email content with AI (OpenRouter)…");
    const draft = await generateEmailWithAI(intent.raw, to);
    if (draft) {
      if (!subject?.trim() && draft.subject) { subject = draft.subject; log(`AI subject: ${subject}`); }
      if (!body?.trim() && draft.body) { body = draft.body; log("AI body generated."); }
    } else {
      warn("OpenRouter key not set or unavailable — using task text as email body.");
      if (!body?.trim()) body = intent.raw;
    }
  }

  log("Opening Gmail compose window...");

  // Click Compose button
  const composedClicked = await lb.click(session, "[data-tooltip='Compose'], .T-I.T-I-KE.L3, [gh='cm'] .T-I", "Compose button in Gmail");
  if (!composedClicked) {
    // Fallback: navigate directly to compose URL
    await lb.navigate(session, "https://mail.google.com/mail/u/0/#compose");
    await lb.wait(session, 2000);
  }
  await lb.wait(session, 1800);

  // Fill recipient — click To field, type, press Enter to chip it
  if (to) {
    await fillGmailToField(session, to, log);
  } else {
    warn("No recipient specified. Please fill in the To field.");
    await lb.waitForUser(session, "Please fill in the recipient address and click Resume when ready");
  }

  // Fill subject
  if (subject) {
    log(`Filling subject: ${subject}`);
    const page = session.page;
    try {
      const subjectLoc = page.locator('input[name="subjectbox"], [aria-label*="Subject"]').first();
      await subjectLoc.click({ timeout: 3000 });
      await lb.wait(session, 100);
      await subjectLoc.fill(subject, { timeout: 3000 });
    } catch {
      await lb.typeText(session, 'input[name="subjectbox"]', subject, "Subject field");
    }
    await lb.wait(session, 400);
  }

  // Fill body
  if (body) {
    log("Typing email body...");
    const page = session.page;
    try {
      const bodyLoc = page
        .locator('[aria-label="Message Body"], .Am.Al.editable, [contenteditable="true"][g_editable]')
        .first();
      await bodyLoc.click({ timeout: 3000 });
      await lb.wait(session, 300);
      await page.keyboard.type(body, { delay: 18 });
    } catch {
      await lb.click(session, '[aria-label="Message Body"], .Am.Al.editable', "Email body area");
      await lb.wait(session, 400);
      await lb.typeAtFocus(session, body);
    }
    await lb.wait(session, 500);
  }

  // Send or pause for manual send
  if (autoSendEmail) {
    log("Attempting to send email automatically…");
    const sent = await tryClickGmailSend(session, log, warn);
    if (!sent) {
      await lb.waitForUser(
        session,
        "Your email is composed. Click Send in Gmail (or fix any issues), then click Resume here",
      );
    }
  } else {
    log("Email is ready. Waiting for your review (NEXUS_AUTO_SEND_EMAIL=0)…");
    await lb.waitForUser(
      session,
      "Your email is composed. Review it and click Send in Gmail, then click Resume here",
    );
  }

  log("Email task complete.");
  return done(
    session,
    true,
    `Email ${autoSendEmail ? "sent or attempted" : "composed"}${to ? ` to ${to}` : ""}${subject ? ` — Subject: ${subject}` : ""}`,
    session.currentUrl,
  );
}

// ─── Job Application via LinkedIn ─────────────────────────────────────────────

async function runJob(
  session: lb.LiveBrowserSession,
  intent: TaskIntent,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<TaskRunnerResult> {
  const { title, company, location, site } = intent.job ?? {};
  const searchQuery = [title, company].filter(Boolean).join(" ");

  if (site === "indeed") {
    return runIndeedJob(session, intent, log, warn);
  }

  // Default: LinkedIn
  log("Opening LinkedIn Jobs...");
  await lb.navigate(session, "https://www.linkedin.com/jobs/");
  await lb.wait(session, 3000);

  const url = session.currentUrl;
  const isLoggedIn = url.includes("linkedin.com/jobs") && !url.includes("linkedin.com/login");

  if (!isLoggedIn) {
    log("LinkedIn needs you to log in first...");
    warn("Not logged in to LinkedIn. Please log in in the browser below.");
    await lb.waitForUser(session, "Please log in to LinkedIn in the browser below, then click Resume");
    await lb.wait(session, 2000);
  }

  log(`Searching for "${searchQuery}" jobs...`);

  // Build LinkedIn jobs search URL
  const jobsSearchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(searchQuery ?? "")}&location=${encodeURIComponent(location ?? "Remote")}&f_AL=true`;
  await lb.navigate(session, jobsSearchUrl);
  await lb.wait(session, 3000);

  log("Looking at job listings...");
  await lb.wait(session, 2000);
  await lb.scroll(session, 300);
  await lb.wait(session, 1000);

  // Click first job listing
  log("Opening first job listing...");
  const clicked = await lb.click(
    session,
    ".job-card-container--clickable, .jobs-search-results__list-item .artdeco-entity-lockup__title, a.job-card-list__title",
    "first job listing"
  );
  await lb.wait(session, 2500);

  if (!clicked) {
    warn("Could not find job listing element. Please click a job manually.");
    await lb.waitForUser(session, "Please click on a job you want to apply to, then click Resume");
  }

  // Click Easy Apply
  log("Looking for Easy Apply button...");
  const appliedClicked = await lb.click(
    session,
    ".jobs-apply-button, [aria-label*='Apply'], button.jobs-apply-button--top-card",
    "Easy Apply button"
  );
  await lb.wait(session, 2000);

  if (!appliedClicked) {
    warn("Easy Apply not available for this job. Please apply manually.");
    await lb.waitForUser(session, "Please click Apply and complete the form, then click Resume");
    return done(session, true, `Opened job listing${title ? ` for ${title}` : ""}. Easy Apply button not found — please apply manually.`);
  }

  log("Application form opened. Advancing Easy Apply…");

  if (autoLinkedInApply) {
    await tryAdvanceLinkedInEasyApply(session, log, warn);
  } else {
    await lb.waitForUser(
      session,
      "Review the application form and fill in any missing fields. Click Submit/Next in the LinkedIn form, then click Resume here when done (NEXUS_AUTO_LINKEDIN_APPLY=0)",
    );
  }

  log("Job application task complete.");
  return done(session, true, `LinkedIn Easy Apply flow for "${searchQuery}"`, session.currentUrl);
}

async function runIndeedJob(
  session: lb.LiveBrowserSession,
  intent: TaskIntent,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<TaskRunnerResult> {
  const { title, location } = intent.job ?? {};
  const q = title ?? "software engineer";
  log(`Searching Indeed for "${q}"...`);
  await lb.navigate(session, `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(location ?? "Remote")}`);
  await lb.wait(session, 3000);

  log("Browsing job listings...");
  await lb.scroll(session, 300);
  await lb.wait(session, 1500);
  await lb.click(session, ".job_seen_beacon h2 a, .jobTitle a", "first job listing on Indeed");
  await lb.wait(session, 3000);

  log("Job opened. Please review and apply.");
  await lb.waitForUser(session, "Review the job listing and click Apply Now. Fill in the application form and click Resume here when done");

  return done(session, true, `Opened Indeed job search for "${q}"`, session.currentUrl);
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

async function runGitHub(
  session: lb.LiveBrowserSession,
  task: string,
  _kimiKey: string | undefined,
  log: (m: string) => void,
  _warn: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log(`Searching GitHub for "${query}"...`);

  if (/trending/i.test(task)) {
    await lb.navigate(session, "https://github.com/trending");
  } else {
    await lb.navigate(session, `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories&s=stars&o=desc`);
  }
  await lb.wait(session, 2500);

  log("Looking at results...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);

  // Click first result
  await lb.click(session, "[data-testid='results-list'] article a, .Box-row h3 a, .repo-list-item h3 a", "first repository");
  await lb.wait(session, 2500);

  log("Exploring repository...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1000);

  log("GitHub task complete.");
  return done(session, true, `Explored GitHub results for "${query}"`, session.currentUrl);
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

async function runYouTube(
  session: lb.LiveBrowserSession,
  task: string,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log(`Searching YouTube for "${query}"...`);
  await lb.navigate(session, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
  await lb.wait(session, 3000);

  log("Found videos. Opening first result...");
  await lb.click(session, "ytd-video-renderer #video-title, a#video-title", "first YouTube video");
  await lb.wait(session, 3000);

  log("Video loading...");
  await lb.wait(session, 3000);
  await lb.scroll(session, 300);
  await lb.wait(session, 1500);

  log("YouTube task complete.");
  return done(session, true, `Opened YouTube video for "${query}"`, session.currentUrl);
}

// ─── Wikipedia ───────────────────────────────────────────────────────────────

async function runWikipedia(
  session: lb.LiveBrowserSession,
  task: string,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log(`Looking up "${query}" on Wikipedia...`);
  await lb.navigate(session, `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}&ns0=1`);
  await lb.wait(session, 2500);

  // If we landed directly on an article
  if (session.currentUrl.includes("/wiki/") && !session.currentUrl.includes("Special:Search")) {
    log("Found Wikipedia article. Reading...");
  } else {
    log("Opening first search result...");
    await lb.click(session, ".mw-search-result-heading a, .searchresult a, li.mw-search-result a", "first Wikipedia result");
    await lb.wait(session, 2500);
  }

  log("Reading article...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1000);

  log("Wikipedia task complete.");
  return done(session, true, `Read Wikipedia article about "${query}"`, session.currentUrl);
}

// ─── LinkedIn Profile Browse ──────────────────────────────────────────────────

async function runLinkedIn(
  session: lb.LiveBrowserSession,
  task: string,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log("Opening LinkedIn...");
  await lb.navigate(session, `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query)}`);
  await lb.wait(session, 3000);

  log("Browsing LinkedIn results...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1200);

  log("LinkedIn task complete.");
  return done(session, true, `Browsed LinkedIn for "${query}"`, session.currentUrl);
}

// ─── Amazon ───────────────────────────────────────────────────────────────────

async function runAmazon(
  session: lb.LiveBrowserSession,
  task: string,
  _kimiKey: string | undefined,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log(`Searching Amazon for "${query}"...`);
  await lb.navigate(session, `https://www.amazon.com/s?k=${encodeURIComponent(query)}`);
  await lb.wait(session, 3000);

  log("Browsing search results...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);

  log("Opening first product...");
  await lb.click(session, "h2 a.a-link-normal, .s-result-item h2 a", "first Amazon product");
  await lb.wait(session, 3000);

  log("Reading product details...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1000);

  log("Amazon task complete.");
  return done(session, true, `Found Amazon products for "${query}"`, session.currentUrl);
}

// ─── Reddit ───────────────────────────────────────────────────────────────────

async function runReddit(
  session: lb.LiveBrowserSession,
  task: string,
  _kimiKey: string | undefined,
  log: (m: string) => void,
  _warn: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log("Opening Reddit search...");
  await lb.navigate(session, `https://old.reddit.com/search?q=${encodeURIComponent(query)}&sort=top`);
  await lb.wait(session, 3000);

  log(`Browsing Reddit results for "${query}"...`);
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);

  log("Opening top post...");
  await lb.click(session, "p.title a.may-blank, .search-result-link a", "first Reddit post");
  await lb.wait(session, 3000);

  log("Reading post and comments...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1200);

  log("Reddit task complete.");
  return done(session, true, `Read Reddit discussions about "${query}"`, session.currentUrl);
}

// ─── DoorDash ─────────────────────────────────────────────────────────────────

async function runDoorDash(
  session: lb.LiveBrowserSession,
  task: string,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log("Opening DoorDash...");
  await lb.navigate(session, "https://www.doordash.com");
  await lb.wait(session, 3000);

  log("Searching for restaurants...");
  await lb.click(session, "[data-anchor-id='SearchButton'], [aria-label='Search']", "Search button");
  await lb.wait(session, 1000);
  await lb.typeText(session, "input[aria-label='Search'], input[placeholder='Search']", query, "DoorDash search input");
  await lb.wait(session, 1500);
  await lb.pressKey(session, "Enter");
  await lb.wait(session, 3000);

  log("Browsing results...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);

  log("DoorDash task complete.");
  return done(session, true, `Browsed DoorDash for "${query}"`, session.currentUrl);
}

// ─── Travel ───────────────────────────────────────────────────────────────────

async function runTravel(
  session: lb.LiveBrowserSession,
  task: string,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);

  if (/hotel/i.test(task)) {
    log("Searching for hotels on Booking.com...");
    const destination = query.replace(/hotel[s]?/i, "").trim();
    await lb.navigate(session, `https://www.booking.com/search.html?ss=${encodeURIComponent(destination)}`);
  } else {
    log("Searching for flights on Google Flights...");
    const dest = query.replace(/flight[s]?|to|from/gi, "").trim();
    await lb.navigate(session, `https://www.google.com/travel/flights?q=${encodeURIComponent("flights " + dest)}`);
  }
  await lb.wait(session, 3000);

  log("Browsing travel results...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);

  log("Travel task complete.");
  return done(session, true, `Browsed travel options for "${query}"`, session.currentUrl);
}

// ─── DuckDuckGo (default search) ──────────────────────────────────────────────

async function runDuckDuckGoSearch(
  session: lb.LiveBrowserSession,
  task: string,
  log: (m: string) => void,
): Promise<TaskRunnerResult> {
  const query = deriveSearchQuery(task);
  log(`Searching the web for "${query}"...`);
  await lb.navigate(session, `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`);
  await lb.wait(session, 2500);

  log("Reading search results...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);

  // Click first organic result
  await lb.click(session, "[data-testid='result-title-a'], .result__a, article[data-testid='result'] a", "first search result");
  await lb.wait(session, 3000);

  log("Reading page...");
  await lb.scroll(session, 400);
  await lb.wait(session, 1500);
  await lb.scroll(session, 400);
  await lb.wait(session, 1000);

  log("Search task complete.");
  return done(session, true, `Searched for "${query}"`, session.currentUrl);
}
