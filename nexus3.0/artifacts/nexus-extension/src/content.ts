/**
 * Runs in the page (isolated world). Tasks mirror the server task-runner flows
 * using DOM APIs instead of Playwright.
 */

import {
  buildLinkedInSearchUrl,
  isLinkedInJobSearchUrl,
  isLinkedInJobViewUrl,
} from "./linkedin-job-url";
import { NEXUS_FILL_FORM_FULL_TASK } from "./extension-constants";
import { parseEmailParts, shouldAutoSendEmail } from "./email-parse";
import type { ApplicationProfile } from "./application-profile";
import {
  fillApplicationFormFullOnPage,
  fillApplicationFormOnPage,
  fillFormWithin,
  loadApplicationProfile,
} from "./form-fill";
import {
  clearlyWantsGmail,
  isEmailIntent,
  isFillApplicationFormIntent,
  isJobIntent,
} from "./task-intents";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function gmailComposeRoot(): HTMLElement {
  return (
    document.querySelector<HTMLElement>('div[role="dialog"][aria-label^="New Message"]') ??
    document.querySelector<HTMLElement>('div[role="dialog"][aria-label*="Compose"]') ??
    document.querySelector<HTMLElement>("div.M9") ??
    document.body
  );
}

function setNativeField(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Gmail’s compose body is a React contenteditable; plain textContent often does not update the real draft. */
function findGmailBodyEl(dialog: HTMLElement): HTMLElement | null {
  const scoped = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      '[aria-label="Message Body"], div[aria-label*="Message"][role="textbox"], [contenteditable="true"][g_editable], .Am.Al.editable, div[contenteditable="true"].Am',
    ),
  );
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of scoped) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (r.height > 40 && area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return (
    best ??
    document.querySelector<HTMLElement>('[aria-label="Message Body"]') ??
    document.querySelector<HTMLElement>(".Am.Al.editable")
  );
}

function setGmailBody(el: HTMLElement, text: string): void {
  const plain = text.replace(/\r\n/g, "\n");
  el.focus();
  el.innerHTML = "";

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, plain);
  } catch {
    inserted = false;
  }

  let got = (el.innerText ?? el.textContent ?? "").trim();
  const want = plain.trim();
  if (!inserted || (want.length > 3 && got.length < Math.min(want.length * 0.35, 10))) {
    el.textContent = "";
    const lines = plain.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) el.appendChild(document.createElement("br"));
      el.appendChild(document.createTextNode(lines[i]!));
    }
    got = (el.innerText ?? el.textContent ?? "").trim();
  }

  try {
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: plain,
      }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  el.focus();
}

async function confirmGmailRecipientField(el: HTMLElement): Promise<void> {
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(120);
  el.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  await wait(400);
}

function heuristicSubjectFromBody(body?: string): string | undefined {
  const b = body?.trim();
  if (!b) return undefined;
  const line = b.split(/\n/)[0]?.trim() ?? "";
  if (!line) return undefined;
  return line.length <= 78 ? line : `${line.slice(0, 75)}…`;
}

function requestAiEmailDraft(
  task: string,
  parts: { to?: string; subject?: string; body?: string },
): Promise<{ subject: string; body: string } | null> {
  return new Promise((resolve) => {
    const finish = (v: { subject: string; body: string } | null) => resolve(v);
    const t = window.setTimeout(() => finish(null), 28_000);
    try {
      chrome.runtime.sendMessage(
        {
          type: "GENERATE_EMAIL_DRAFT",
          task,
          body: parts.body,
          to: parts.to,
          subject: parts.subject,
        },
        (r: { ok?: boolean; subject?: string; body?: string } | undefined) => {
          window.clearTimeout(t);
          if (chrome.runtime.lastError) {
            finish(null);
            return;
          }
          if (r?.ok && (r.subject?.trim() || r.body?.trim())) {
            finish({
              subject: (r.subject ?? "").trim(),
              body: (r.body ?? "").trim(),
            });
            return;
          }
          finish(null);
        },
      );
    } catch {
      window.clearTimeout(t);
      finish(null);
    }
  });
}

async function runGmailCompose(task: string): Promise<string> {
  if (!window.location.hostname.includes("mail.google.com")) {
    window.location.assign("https://mail.google.com/mail/u/0/");
    return "Opening Gmail… Run the task again after the inbox loads.";
  }

  const parsed = parseEmailParts(task);
  let { to, subject, body } = parsed;

  const hasSubject = Boolean(subject?.trim());
  const hasBody = Boolean(body?.trim());
  const canUseAiForDraft = (!hasSubject || !hasBody) && (Boolean(to?.trim()) || task.trim().length > 6);

  if (canUseAiForDraft) {
    const draft = await requestAiEmailDraft(task, { to, subject, body });
    if (draft) {
      if (!hasSubject && draft.subject) subject = draft.subject;
      if (!hasBody && draft.body) body = draft.body;
    }
    if (!hasSubject && !subject?.trim()) subject = heuristicSubjectFromBody(body);
  }

  if (!body?.trim() && (to?.trim() || subject?.trim())) {
    body = subject?.trim()
      ? `Hello,\n\nI'm writing regarding: ${subject.trim()}\n\nBest regards,`
      : "Hello,\n\nI wanted to reach out.\n\nBest regards,";
  }

  const composeBtn = document.querySelector<HTMLElement>(
    "[data-tooltip='Compose'], [data-tooltip*='Compose'], .T-I.T-I-KE.L3, [gh='cm'] .T-I, div[role='button'][aria-label*='Compose']",
  );
  if (composeBtn) {
    composeBtn.click();
  } else {
    window.location.assign("https://mail.google.com/mail/u/0/#compose");
    return "Opening Gmail compose… Run the task again after it loads.";
  }
  await wait(2400);

  const root = gmailComposeRoot();
  const dialog =
    document.querySelector<HTMLElement>('[role="dialog"][aria-label^="New Message"]') ??
    document.querySelector<HTMLElement>('[role="dialog"][aria-label*="Compose"]') ??
    document.querySelector<HTMLElement>('div[role="dialog"]') ??
    root.closest<HTMLElement>('[role="dialog"]') ??
    root;

  if (to) {
    const toField =
      dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'textarea[name="to"], input[name="to"], textarea[aria-label*="To"], textarea[aria-label*="Recipients"], input[aria-label*="To"]',
      ) ??
      document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'textarea[name="to"], textarea[aria-label*="To"], textarea[aria-label*="Recipients"]',
      );
    if (toField) {
      toField.focus();
      setNativeField(toField, to);
      await wait(200);
      await confirmGmailRecipientField(toField);
    }
  }

  if (subject) {
    const subj =
      dialog.querySelector<HTMLInputElement>(
        'input[name="subjectbox"], input[placeholder*="Subject"], input[aria-label*="Subject"]',
      ) ?? document.querySelector<HTMLInputElement>('input[name="subjectbox"], input[aria-label*="Subject"]');
    if (subj) {
      subj.focus();
      setNativeField(subj, subject);
      await wait(500);
    }
  }

  if (body) {
    await wait(300);
    let bodyEl = findGmailBodyEl(dialog);
    if (bodyEl) {
      setGmailBody(bodyEl, body);
      await wait(400);
      const check = (bodyEl.innerText ?? bodyEl.textContent ?? "").trim();
      if (check.length < Math.min(body.trim().length * 0.4, 12)) {
        bodyEl = findGmailBodyEl(dialog);
        if (bodyEl) setGmailBody(bodyEl, body);
      }
      await wait(600);
    }
  }

  const summaryBits: string[] = [];
  if (to) summaryBits.push(`To: ${to}`);
  if (subject) summaryBits.push(`Subject: ${subject}`);
  if (body) summaryBits.push(`Body: ${body.length > 120 ? `${body.slice(0, 120)}…` : body}`);
  const summary = summaryBits.length > 0 ? summaryBits.join(" · ") : "(no recipient/subject/body parsed — use clearer phrases)";

  const autoSend = shouldAutoSendEmail(task, {
    to,
    subject,
    body,
  });
  if (!autoSend) {
    return `Compose filled. ${summary} — review and click Send.`;
  }

  await wait(1200);

  const sendScope = dialog;
  const sendSelectors = [
    '[data-tooltip="Send"]',
    '[data-tooltip*="Send"]',
    'div[role="button"][aria-label^="Send"]',
    'div[role="button"][aria-label*="Send"]',
  ];
  const sendLooksDisabled = (el: HTMLElement): boolean => {
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el instanceof HTMLButtonElement && el.disabled) return true;
    return false;
  };

  for (let round = 0; round < 5; round++) {
    if (round > 0) await wait(1000);
    for (const sel of sendSelectors) {
      const el = sendScope.querySelector<HTMLElement>(sel) ?? document.querySelector<HTMLElement>(sel);
      if (el && !sendLooksDisabled(el)) {
        el.click();
        await wait(1500);
        return `Send clicked. ${summary}`;
      }
    }
  }

  return `Filled compose. ${summary} — Send stayed disabled or not found; check To/Body in Gmail.`;
}

function onLinkedInJobsSite(): boolean {
  try {
    const h = window.location.hostname;
    const p = window.location.pathname;
    return h.includes("linkedin.com") && p.includes("/jobs");
  } catch {
    return false;
  }
}

/** Right-hand job detail pane — document-wide “Apply” hits filters or wrong cards. */
function linkedInJobDetailsRoot(): HTMLElement {
  return (
    document.querySelector<HTMLElement>(
      ".jobs-search__job-details, .jobs-details-top-card, .jobs-details__main-content, .scaffold-layout__detail",
    ) ?? document.body
  );
}

/** Job list column only (avoid matching links inside the detail pane first). */
function linkedInJobListRoot(): HTMLElement {
  return (
    document.querySelector<HTMLElement>(".jobs-search-results__list") ??
    document.querySelector<HTMLElement>(".scaffold-layout__list") ??
    document.body
  );
}

function isLikelyVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0;
}

function syntheticClick(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "auto" });
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  if (typeof el.click === "function") el.click();
}

function jobListRowForLink(link: HTMLElement): Element | null {
  return (
    link.closest("li.jobs-search-results__list-item") ??
    link.closest("li.scaffold-layout__list-item") ??
    link.closest("li")
  );
}

/** Sidebar row already shows Applied (skip without opening). */
function jobRowLooksAlreadyApplied(row: Element): boolean {
  return /\bApplied\b/i.test(row.textContent ?? "");
}

/** Detail pane shows you already submitted (Easy Apply won’t offer the same flow). */
function isJobDetailAlreadyApplied(): boolean {
  const root = linkedInJobDetailsRoot();
  const t = root.textContent ?? "";
  if (/Applied\s+less than a minute ago/i.test(t)) return true;
  if (/Applied\s+\d+\s*(minute|hour|day|second|week|month)s?\s+ago/i.test(t)) return true;
  if (/\bYou applied\b/i.test(t) && /See application/i.test(t)) return true;
  if (/\bYou applied to this job\b/i.test(t)) return true;
  return false;
}

/**
 * Ordered /jobs/view/ links from the results list, deduped by job id.
 * Skips rows whose card text already includes “Applied”.
 */
function getJobListingClickables(): HTMLElement[] {
  const ul =
    document.querySelector<HTMLElement>("ul.jobs-search-results__list") ?? linkedInJobListRoot();
  const candidates = ul.querySelectorAll<HTMLElement>("a[href*='/jobs/view/']");
  const out: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const el of candidates) {
    if (!isLikelyVisible(el)) continue;
    const href = el.getAttribute("href") ?? "";
    const idMatch = href.match(/\/jobs\/view\/(\d+)/);
    const id = idMatch?.[1] ?? href.split("?")[0];
    if (seen.has(id)) continue;
    const row = jobListRowForLink(el);
    if (row && jobRowLooksAlreadyApplied(row)) continue;
    seen.add(id);
    out.push(el);
  }
  return out;
}

const MAX_JOB_LISTINGS_TO_TRY = 25;

async function tryEasyApplyOnSearchResults(task: string): Promise<string> {
  const links = getJobListingClickables();
  if (links.length === 0) {
    return "Could not find job listings. Scroll the list and run again.";
  }

  const limit = Math.min(links.length, MAX_JOB_LISTINGS_TO_TRY);
  for (let i = 0; i < limit; i++) {
    syntheticClick(links[i]);
    await wait(2800);

    if (isJobDetailAlreadyApplied()) {
      continue;
    }

    const started = await clickEasyApply();
    if (!started) {
      continue;
    }

    await advanceEasyApplySteps();
    return `Easy Apply flow advanced (listing ${i + 1}) for: ${task.slice(0, 72)}…`;
  }

  return "No Easy Apply found: every listing tried was already applied or only has external Apply.";
}

async function clickEasyApply(): Promise<boolean> {
  const root = linkedInJobDetailsRoot();

  const byText = Array.from(
    root.querySelectorAll<HTMLElement>("button, a.artdeco-button, a[role='button']"),
  ).filter((el) => {
    const t = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
    return /easy\s*apply/i.test(t) && isLikelyVisible(el) && !el.disabled;
  });
  const pick = byText[0];
  if (pick) {
    await wait(400);
    syntheticClick(pick);
    await wait(2800);
    return true;
  }

  const selectors = [
    "button.jobs-apply-button--top-card",
    "button.jobs-apply-button",
    "button[data-live-test-easy-apply-button]",
    ".jobs-apply-button--top-card",
    "button.jobs-apply-button--medium",
    'button[aria-label*="Easy Apply" i]',
    'button[aria-label*="Easy apply" i]',
    'a[aria-label*="Easy Apply" i]',
  ];
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el && isLikelyVisible(el) && !el.disabled) {
      await wait(400);
      syntheticClick(el);
      await wait(2800);
      return true;
    }
  }
  return false;
}

function easyApplyRoot(): HTMLElement {
  return (document.querySelector('[role="dialog"]') as HTMLElement | null) ?? document.body;
}

function lnNorm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function linkedInAnswerForLabel(label: string, profile: ApplicationProfile): string {
  const L = lnNorm(label);
  if (!L) return "";
  if (/e-mail|email/.test(L)) return profile.email.trim();
  if (/phone|mobile|cell|contact number/.test(L)) return profile.phone.trim();
  if (/\bcountry\b/.test(L)) return profile.country.trim();
  if (/\bstate\b|province|region/.test(L)) return profile.state.trim();
  if (/\bcity\b|town/.test(L)) return profile.city.trim();
  if (/zip|postal|post code/.test(L)) return profile.zipCode.trim();
  if (/street|address line|mailing address/.test(L)) return profile.streetAddress.trim();
  if (/first name|given name/.test(L)) return profile.firstName.trim();
  if (/last name|surname|family name/.test(L)) return profile.lastName.trim();
  if (/full name|your name/.test(L)) {
    return profile.fullName.trim() || [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  }
  if (/linkedin|linked-in/.test(L)) return profile.linkedInUrl.trim();
  if (/website|portfolio|url|github/.test(L)) return (profile.portfolioUrl || profile.linkedInUrl).trim();
  if (/employer|company|organization/.test(L)) return profile.currentEmployer.trim();
  if (/job title|position title|your title/.test(L)) return profile.currentJobTitle.trim();
  return "";
}

async function pickLinkedInListboxOptions(root: Element, profile: ApplicationProfile): Promise<number> {
  let picked = 0;
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".jobs-easy-apply-form-element, fieldset.jobs-easy-apply-form-element, [data-test-form-element]",
    ),
  );

  for (const block of blocks) {
    if (!isLikelyVisible(block)) continue;

    if (block.querySelector("select")) continue;

    const trigger = block.querySelector<HTMLElement>(
      'button[aria-haspopup="listbox"], .jobs-easy-apply-form-element__dropdown-trigger, button.artdeco-dropdown__trigger, button[data-test-plan-dropdown]',
    );
    if (!trigger || !isLikelyVisible(trigger) || trigger.disabled) continue;

    const labelEl =
      block.querySelector<HTMLElement>(".jobs-easy-apply-form-element__label, legend, label") ?? block;
    const want = linkedInAnswerForLabel(labelEl.textContent ?? "", profile);

    const shown = lnNorm(trigger.textContent ?? trigger.getAttribute("aria-label") ?? "");
    if (want && shown.includes(lnNorm(want))) continue;
    if (
      shown.length > 2 &&
      !/^select\b/.test(shown) &&
      !/^choose\b/.test(shown) &&
      !/^pick\b/.test(shown) &&
      !/^please\b/.test(shown)
    ) {
      continue;
    }

    syntheticClick(trigger);
    await wait(550);

    const options = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="listbox"] [role="option"], ul[role="listbox"] li[role="option"], .artdeco-dropdown--is-dropdown-element li[role="option"], li.artdeco-dropdown__item',
      ),
    ).filter((o) => isLikelyVisible(o));

    let choice: HTMLElement | null = null;
    if (want) {
      const wn = lnNorm(want);
      choice =
        options.find((o) => {
          const t = lnNorm(o.textContent ?? "");
          return t.length > 0 && (t === wn || t.includes(wn) || wn.includes(t));
        }) ?? null;
    }
    if (!choice) {
      choice =
        options.find((o) => {
          const t = (o.textContent ?? "").trim();
          return (
            t.length > 0 &&
            !/^select\b/i.test(t) &&
            !/^choose\b/i.test(t) &&
            !/^please select\b/i.test(t) &&
            !/^—/.test(t)
          );
        }) ?? null;
    }
    if (!choice && options.length) choice = options[0]!;

    if (choice) {
      syntheticClick(choice);
      picked++;
      await wait(450);
    } else {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await wait(200);
    }
  }
  return picked;
}

function clickLinkedInConsentRadios(root: Element): number {
  let n = 0;
  const blocks = root.querySelectorAll<HTMLElement>(".jobs-easy-apply-form-element, fieldset");
  for (const block of blocks) {
    const lab = block.querySelector("legend, .jobs-easy-apply-form-element__label");
    const L = lab?.textContent ?? "";
    if (!L.trim()) continue;

    if (/(authorized|authorised|legally permitted|eligible to work|work authorization|right to work)/i.test(L)) {
      const yes = Array.from(block.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) =>
        /^(yes|true|y)$/i.test(r.value.trim()),
      );
      if (yes && !yes.checked) {
        yes.click();
        n++;
      }
    }
    if (/require sponsorship|visa sponsorship|sponsor.*visa|will you now or in the future require/i.test(L)) {
      const no = Array.from(block.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) =>
        /^(no|false|n)$/i.test(r.value.trim()),
      );
      if (no && !no.checked) {
        no.click();
        n++;
      }
    }
  }
  return n;
}

async function fillLinkedInEasyApplyFields(shell: HTMLElement, profile: ApplicationProfile): Promise<void> {
  const hasAny =
    profile.email.trim() ||
    profile.phone.trim() ||
    profile.firstName.trim() ||
    profile.fullName.trim() ||
    profile.lastName.trim();
  if (!hasAny) return;

  fillFormWithin(shell, profile);
  clickLinkedInConsentRadios(shell);
  await pickLinkedInListboxOptions(shell, profile);
}

async function advanceEasyApplySteps(max = 24): Promise<void> {
  const profile = await loadApplicationProfile();
  for (let i = 0; i < max; i++) {
    await wait(700);
    const shell = easyApplyRoot();
    const text = shell.textContent ?? "";
    if (/Application submitted|You applied|submitted your application/i.test(text)) {
      return;
    }

    await fillLinkedInEasyApplyFields(shell, profile);
    await wait(350);

    const buttons = Array.from(shell.querySelectorAll<HTMLButtonElement>("button"));
    const next = buttons.find((b) => {
      const t = b.textContent?.trim() ?? "";
      return /^(Next|Continue|Review|Submit application|Submit)$/i.test(t) && !b.disabled;
    });
    if (next) {
      next.click();
      await wait(1200);
      continue;
    }

    const primary = shell.querySelector<HTMLElement>(
      "button[data-easy-apply-next-button], .jobs-easy-apply-footer button.artdeco-button--primary",
    );
    if (primary && !primary.hasAttribute("disabled")) {
      primary.click();
      await wait(1200);
      continue;
    }
    break;
  }
}

async function runLinkedInJob(task: string): Promise<string> {
  const href = window.location.href;

  if (isLinkedInJobViewUrl(href)) {
    await wait(1200);
    if (isJobDetailAlreadyApplied()) {
      return "This job is already applied. Open Jobs search for this role and run again to try another listing.";
    }
    const applied = await clickEasyApply();
    if (!applied) {
      return "Easy Apply not found on this job page.";
    }
    await advanceEasyApplySteps();
    return `Easy Apply flow advanced (job page) for: ${task.slice(0, 80)}…`;
  }

  if (!isLinkedInJobSearchUrl(href)) {
    window.location.assign(buildLinkedInSearchUrl(task));
    return "Opening LinkedIn job search… Run again if the page does not load.";
  }

  await wait(2000);
  return tryEasyApplyOnSearchResults(task);
}

async function runTaskInPage(task: string): Promise<string> {
  const t = task.trim();
  if (!t) return "Empty task.";

  if (t === NEXUS_FILL_FORM_FULL_TASK) {
    return fillApplicationFormFullOnPage();
  }

  if (onLinkedInJobsSite() && isJobIntent(t)) {
    return runLinkedInJob(t);
  }

  if (clearlyWantsGmail(t)) {
    return runGmailCompose(t);
  }

  if (isEmailIntent(t)) {
    return runGmailCompose(t);
  }

  if (isFillApplicationFormIntent(t)) {
    // Same pipeline as post-URL navigation: try Apply, wait for SPA, multi-step Next, stronger matching.
    return fillApplicationFormFullOnPage();
  }

  if (isJobIntent(t)) {
    return runLinkedInJob(t);
  }

  return `No in-tab handler for this task yet. Try email (Gmail) or job (LinkedIn) phrases. Task: ${t.slice(0, 100)}`;
}

/** Programmatic `executeScript` can inject this file again; register the listener only once per isolated world. */
const g = globalThis as unknown as Record<string, boolean>;
if (!g.__nexusContentScriptRegistered) {
  g.__nexusContentScriptRegistered = true;
  chrome.runtime.onMessage.addListener(
    (msg: { type?: string; task?: string }, _sender, sendResponse) => {
      if (msg?.type !== "EXECUTE_TASK" || typeof msg.task !== "string") {
        return;
      }

      void runTaskInPage(msg.task)
        .then((result) =>
          sendResponse({ ok: true, result, url: window.location.href }),
        )
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );

      return true;
    },
  );
}
