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
  buildFoodOrderUrl,
  clearlyWantsGmail,
  isEmailIntent,
  isFillApplicationFormIntent,
  isFoodOrderIntent,
  isGmailFormalizeIntent,
  isGmailMailSearchIntent,
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

/** Prefer a visible compose dialog; avoids targeting the wrong overlay when several dialogs exist. */
function findOpenGmailComposeDialog(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('div[role="dialog"]');
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const d of dialogs) {
    const label = d.getAttribute("aria-label") ?? "";
    if (!/new message|compose/i.test(label)) continue;
    const r = d.getBoundingClientRect();
    const area = r.width * r.height;
    if (r.width < 80 || r.height < 80) continue;
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

function findGmailSubjectInput(dialog: HTMLElement): HTMLInputElement | null {
  return (
    dialog.querySelector<HTMLInputElement>('input[name="subjectbox"]') ??
    dialog.querySelector<HTMLInputElement>('input[placeholder*="Subject"]') ??
    dialog.querySelector<HTMLInputElement>('input[aria-label*="Subject"]') ??
    null
  );
}

function gmailFieldUsable(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width >= 2 && r.height >= 2) return true;
  const combo = el.closest<HTMLElement>('[role="combobox"]');
  if (!combo) return false;
  const cr = combo.getBoundingClientRect();
  return cr.width >= 28 && cr.height >= 12;
}

/**
 * Gmail’s To line is often a 0×0 focus sink inside a combobox above the Subject row.
 * Prefer fields geometrically above `input[name=subjectbox]`, not the first random combobox.
 */
function findGmailToField(dialog: HTMLElement): HTMLElement | null {
  const named =
    dialog.querySelector<HTMLElement>('textarea[name="to"]') ??
    dialog.querySelector<HTMLElement>('input[name="to"]');
  if (named) return named;

  for (const cb of dialog.querySelectorAll<HTMLElement>('div[role="combobox"]')) {
    const al = (cb.getAttribute("aria-label") ?? "").toLowerCase();
    if (al.includes("subject") || (al.includes("search") && (al.includes("mail") || al.includes("all")))) continue;
    if (/^bcc\b/i.test(al) || al.includes("bcc")) continue;
    if ((/^cc\b/i.test(al) || /\bcc\b/i.test(al)) && !/\bto\b/i.test(al)) continue;
    if (al.includes("to") || al.includes("recipient")) {
      const inner =
        cb.querySelector<HTMLElement>('input[aria-autocomplete="list"]') ??
        cb.querySelector<HTMLElement>("input[autocomplete]") ??
        cb.querySelector<HTMLElement>('input:not([type="hidden"])') ??
        cb.querySelector<HTMLElement>("textarea") ??
        cb.querySelector<HTMLElement>('[contenteditable="true"]');
      if (inner) return inner;
    }
  }

  const subjectEl = findGmailSubjectInput(dialog);
  const subjectTop = subjectEl?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;

  const scored: { el: HTMLElement; score: number }[] = [];

  const consider = (el: HTMLElement | null, bonus: number) => {
    if (!el || el === subjectEl) return;
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === "hidden" || t === "checkbox" || t === "radio" || t === "submit" || t === "button") return;
    }
    if (!gmailFieldUsable(el)) return;
    const ar = (el.getAttribute("aria-label") ?? "").toLowerCase();
    if (ar.includes("subject")) return;
    if (ar.includes("search") && (ar.includes("mail") || ar.includes("all"))) return;
    const r = el.getBoundingClientRect();
    const midY = r.top + r.height / 2;
    if (Number.isFinite(subjectTop) && midY >= subjectTop - 2) return;

    let score = bonus + Math.min(800, Math.floor(r.width));
    if (/\bto\b/i.test(ar) || ar.includes("recipient")) score += 4000;
    const nm = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.name : "";
    if (nm === "to") score += 2500;
    scored.push({ el, score });
  };

  const quickTo =
    dialog.querySelector<HTMLElement>('input[aria-label*="ecipients"]') ??
    dialog.querySelector<HTMLElement>('textarea[aria-label*="ecipients"]') ??
    dialog.querySelector<HTMLElement>('input[aria-label*="To"]') ??
    dialog.querySelector<HTMLElement>('textarea[aria-label*="To"]');
  if (quickTo && gmailFieldUsable(quickTo)) {
    const ar = (quickTo.getAttribute("aria-label") ?? "").toLowerCase();
    if (!ar.includes("subject")) return quickTo;
  }

  const labeledSelectors = [
    'textarea[aria-label="To"]',
    'textarea[aria-label^="To "]',
    'textarea[aria-label*="To recipients"]',
    'textarea[aria-label*="Recipients"]',
    'input[aria-label="To"]',
    'input[aria-label^="To "]',
    'input[aria-label*="To recipients"]',
    'input[aria-label*="Recipients"]',
    'textarea[name="to"]',
    'input[name="to"]',
  ];
  for (const sel of labeledSelectors) {
    consider(dialog.querySelector<HTMLElement>(sel), 1200);
  }

  for (const cb of dialog.querySelectorAll<HTMLElement>('div[role="combobox"]')) {
    const al = (cb.getAttribute("aria-label") ?? "").toLowerCase();
    const bonus = al.includes("to") || al.includes("recipient") ? 800 : 0;
    const inner =
      cb.querySelector<HTMLElement>('input[type="text"]') ??
      cb.querySelector<HTMLElement>('input:not([type="hidden"])') ??
      cb.querySelector<HTMLElement>("textarea") ??
      cb.querySelector<HTMLElement>('[contenteditable="true"]');
    consider(inner ?? cb, bonus);
  }

  for (const el of dialog.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
    const ar = (el.getAttribute("aria-label") ?? "").toLowerCase();
    if (ar.includes("to") || ar.includes("recipient")) consider(el, 900);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.el ?? null;
}

function gmailComposeLikelyHasRecipient(dialog: HTMLElement, toEmail: string): boolean {
  const want = toEmail.trim().toLowerCase();
  if (!want) return false;
  const local = want.split("@")[0] ?? want;

  for (const el of dialog.querySelectorAll<HTMLElement>("[data-hovercard-id]")) {
    const id = (el.getAttribute("data-hovercard-id") ?? "").toLowerCase();
    if (id.includes(want)) return true;
  }

  for (const el of dialog.querySelectorAll<HTMLElement>("span[email]")) {
    const em = (el.getAttribute("email") ?? "").toLowerCase();
    if (em.includes(want)) return true;
  }

  const named = dialog.querySelector<HTMLTextAreaElement>('textarea[name="to"]');
  if (named?.value?.toLowerCase().includes(want)) return true;

  for (const inp of dialog.querySelectorAll<HTMLInputElement>('input[type="text"]')) {
    const v = inp.value?.toLowerCase() ?? "";
    if (v.includes(want) || v.includes(local)) return true;
  }

  for (const comb of dialog.querySelectorAll<HTMLElement>('div[role="combobox"]')) {
    const al = (comb.getAttribute("aria-label") ?? "").toLowerCase();
    if (al.includes("subject") || (/^cc\b|^bcc\b/i.test(al) && !/\bto\b/i.test(al))) continue;
    const t = (comb.innerText ?? "").toLowerCase().replace(/\s+/g, "");
    if (t.includes(want.replace(/\s/g, ""))) return true;
  }

  const chips = dialog.querySelectorAll<HTMLElement>(
    ".afp, .afz, [data-hovercard-id], span[email], .gD",
  );
  for (const el of chips) {
    const t = (el.textContent ?? "").toLowerCase().replace(/\s/g, "");
    if (t.includes(want.replace(/\s/g, "")) || t.includes(local)) return true;
  }

  return false;
}

/** Gmail often shows a contact list — pick the first matching row so Enter doesn’t dismiss without a chip. */
function clickFirstAutocompleteOption(dialogScope: HTMLElement, wantEmail: string): boolean {
  const want = wantEmail.trim().toLowerCase();
  const listboxes = dialogScope.querySelectorAll<HTMLElement>('[role="listbox"]');
  for (const lb of listboxes) {
    const r = lb.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const opts = lb.querySelectorAll<HTMLElement>('[role="option"]');
    for (const opt of opts) {
      const t = (opt.innerText ?? "").toLowerCase();
      if (!t.includes("@")) continue;
      if (t.includes(want) || want.includes(t.split("@")[0]?.trim() ?? "")) {
        opt.scrollIntoView({ block: "nearest", behavior: "auto" });
        const ev = { bubbles: true, cancelable: true, view: window };
        opt.dispatchEvent(new MouseEvent("mousedown", ev));
        opt.dispatchEvent(new MouseEvent("mouseup", ev));
        opt.dispatchEvent(new MouseEvent("click", ev));
        if (typeof opt.click === "function") opt.click();
        return true;
      }
    }
    const first = opts[0];
    if (first && (first.innerText ?? "").includes("@")) {
      first.scrollIntoView({ block: "nearest", behavior: "auto" });
      const ev = { bubbles: true, cancelable: true, view: window };
      first.dispatchEvent(new MouseEvent("mousedown", ev));
      first.dispatchEvent(new MouseEvent("mouseup", ev));
      first.dispatchEvent(new MouseEvent("click", ev));
      if (typeof first.click === "function") first.click();
      return true;
    }
  }
  return false;
}

async function setGmailRecipientField(
  el: HTMLElement,
  email: string,
  opts?: { extraEnter?: boolean },
): Promise<void> {
  const addr = email.trim();
  if (!addr) return;

  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  await wait(60);
  el.focus();
  await wait(40);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await wait(80);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select?.();
    setNativeField(el, addr);
  } else {
    el.textContent = "";
    try {
      document.execCommand("insertText", false, addr);
    } catch {
      el.textContent = addr;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  await wait(120);

  let looks = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? el.value
    : (el.innerText ?? el.textContent ?? "")
  )
    .trim()
    .toLowerCase();
  if (!looks.includes("@")) {
    el.focus();
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", addr);
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch {
      /* ClipboardEvent paste is best-effort */
    }
    await wait(150);
  }

  const fireKey = async (key: string, code: string, keyCode: number) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
    await wait(40);
    el.dispatchEvent(
      new KeyboardEvent("keyup", {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
    await wait(220);
  };

  const scope = el.closest('[role="dialog"]') ?? document.body;
  await wait(280);
  const picked = clickFirstAutocompleteOption(scope, addr);
  if (!picked) {
    // Enter adds the address as a chip (avoid Tab/comma — focus can jump to Subject).
    await fireKey("Enter", "Enter", 13);
  } else {
    await wait(200);
  }
  if (opts?.extraEnter) {
    await fireKey("Enter", "Enter", 13);
  }
}

/** If the address is still plain text, try keyboard selection of the first suggestion (no re-type). */
async function nudgeGmailRecipientChip(el: HTMLElement): Promise<void> {
  el.focus();
  await wait(60);
  const fireKey = async (key: string, code: string, keyCode: number) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
    await wait(40);
    el.dispatchEvent(
      new KeyboardEvent("keyup", {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
    await wait(160);
  };
  await fireKey("ArrowDown", "ArrowDown", 40);
  await fireKey("Enter", "Enter", 13);
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

/** Gmail’s compose body is a React contenteditable; empty editor can be short — don’t require 40px height. */
function findGmailBodyElInRoot(root: HTMLElement, dialogForY: HTMLElement, subjectEl: HTMLInputElement | null): HTMLElement | null {
  const subjBottom = subjectEl?.getBoundingClientRect().bottom ?? 0;
  const selectors = [
    '[aria-label="Message Body"]',
    '[role="textbox"][aria-label*="Message"]',
    '[role="textbox"][aria-multiline="true"]',
    "[contenteditable=\"true\"][g_editable]",
    ".Am.Al.editable",
    "div[contenteditable=\"true\"].Am",
    "div[contenteditable=\"plaintext-only\"]",
  ];
  const seen = new Set<HTMLElement>();
  const candidates: HTMLElement[] = [];
  for (const sel of selectors) {
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const ar = (el.getAttribute("aria-label") ?? "").toLowerCase();
      if (ar.includes("subject") || ar.includes("to ") || ar.includes("recipient")) return;
      candidates.push(el);
    });
  }

  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width < 72 || r.height < 18) continue;
    if (subjectEl && root === dialogForY && r.bottom <= subjBottom + 2) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

function findGmailBodyEl(dialog: HTMLElement): HTMLElement | null {
  const subjectEl = findGmailSubjectInput(dialog);
  let el = findGmailBodyElInRoot(dialog, dialog, subjectEl);
  if (el) return el;

  for (const fr of dialog.querySelectorAll("iframe")) {
    try {
      const doc = fr.contentDocument;
      if (doc?.body) {
        el = findGmailBodyElInRoot(doc.body, dialog, subjectEl);
        if (el) return el;
      }
    } catch {
      /* cross-origin */
    }
  }

  return (
    dialog.querySelector<HTMLElement>('[aria-label="Message Body"]') ??
    dialog.querySelector<HTMLElement>(".Am.Al.editable")
  );
}

function setGmailBody(el: HTMLElement, text: string): void {
  const plain = text.replace(/\r\n/g, "\n");
  el.focus();
  el.innerHTML = "";
  try {
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: plain,
      }),
    );
  } catch {
    /* ignore */
  }

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

function requestFormalizeEmailDraft(parts: {
  subject: string;
  body: string;
  task?: string;
}): Promise<{ subject: string; body: string } | null> {
  return new Promise((resolve) => {
    const finish = (v: { subject: string; body: string } | null) => resolve(v);
    const timer = window.setTimeout(() => finish(null), 28_000);
    try {
      chrome.runtime.sendMessage(
        {
          type: "FORMALIZE_EMAIL_DRAFT",
          subject: parts.subject,
          body: parts.body,
          task: parts.task ?? "",
        },
        (r: { ok?: boolean; subject?: string; body?: string } | undefined) => {
          window.clearTimeout(timer);
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
      window.clearTimeout(timer);
      finish(null);
    }
  });
}

async function runGmailFormalizeDraft(task: string): Promise<string> {
  if (!window.location.hostname.includes("mail.google.com")) {
    window.location.assign("https://mail.google.com/mail/u/0/");
    return "Opening Gmail… Open your draft, then run the formalize command again.";
  }

  let dialog = findOpenGmailComposeDialog();
  if (!dialog) {
    const root = gmailComposeRoot();
    dialog =
      document.querySelector<HTMLElement>('[role="dialog"][aria-label^="New Message"]') ??
      document.querySelector<HTMLElement>('[role="dialog"][aria-label*="Compose"]') ??
      root.closest<HTMLElement>('[role="dialog"]') ??
      null;
  }
  if (!dialog) {
    return "Open New Message, type your rough subject and body, then say: make this email formal.";
  }

  const subj = findGmailSubjectInput(dialog);
  const subjectRaw = (subj?.value ?? "").trim();
  const bodyEl = findGmailBodyEl(dialog);
  const bodyRaw = (bodyEl?.innerText ?? bodyEl?.textContent ?? "").trim();

  if (!subjectRaw && !bodyRaw) {
    return "Put something in Subject or the message body first, then ask to rewrite it formally.";
  }

  const out = await requestFormalizeEmailDraft({
    subject: subjectRaw,
    body: bodyRaw,
    task,
  });
  if (!out?.subject?.trim() && !out?.body?.trim()) {
    return "Could not rewrite — add a Groq API key in the Nexus side panel (BYOK), then try again.";
  }

  if (out.subject && subj) {
    subj.focus();
    setNativeField(subj, out.subject);
    await wait(220);
  }

  if (out.body) {
    let el = findGmailBodyEl(dialog) ?? bodyEl;
    if (el) {
      setGmailBody(el, out.body);
      await wait(350);
      const check = (el.innerText ?? el.textContent ?? "").trim();
      if (check.length < Math.min(out.body.trim().length * 0.35, 15)) {
        el = findGmailBodyEl(dialog) ?? el;
        setGmailBody(el, out.body);
      }
    }
  }

  return "Draft rewritten in a formal tone — review To and Send when ready.";
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

  if (subject?.trim() && body?.trim() && subject.trim() === body.trim()) {
    body = `Hello,\n\n${body.trim()}\n\nBest regards,`;
  }

  let dialog = findOpenGmailComposeDialog();
  if (!dialog) {
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
    dialog = findOpenGmailComposeDialog();
  }

  const root = gmailComposeRoot();
  const resolvedDialog =
    dialog ??
    document.querySelector<HTMLElement>('[role="dialog"][aria-label^="New Message"]') ??
    document.querySelector<HTMLElement>('[role="dialog"][aria-label*="Compose"]') ??
    document.querySelector<HTMLElement>('div[role="dialog"]') ??
    root.closest<HTMLElement>('[role="dialog"]') ??
    root;

  if (to) {
    let toField = findGmailToField(resolvedDialog);
    if (!toField) {
      await wait(400);
      toField = findGmailToField(resolvedDialog);
    }
    if (toField) {
      await setGmailRecipientField(toField, to);
      await wait(300);
      if (!gmailComposeLikelyHasRecipient(resolvedDialog, to)) {
        await setGmailRecipientField(toField, to, { extraEnter: true });
        await wait(400);
      }
      if (!gmailComposeLikelyHasRecipient(resolvedDialog, to)) {
        await nudgeGmailRecipientChip(toField);
        await wait(400);
      }
    }
  }

  const subj =
    findGmailSubjectInput(resolvedDialog) ??
    document.querySelector<HTMLInputElement>('input[name="subjectbox"], input[aria-label*="Subject"]');
  subj?.focus();
  await wait(120);

  if (subject && subj) {
    setNativeField(subj, subject);
    await wait(500);
  }

  if (body) {
    await wait(300);
    let bodyEl = findGmailBodyEl(resolvedDialog);
    if (bodyEl) {
      setGmailBody(bodyEl, body);
      await wait(400);
      const check = (bodyEl.innerText ?? bodyEl.textContent ?? "").trim();
      if (check.length < Math.min(body.trim().length * 0.4, 12)) {
        bodyEl = findGmailBodyEl(resolvedDialog);
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

  if (to?.trim() && !gmailComposeLikelyHasRecipient(resolvedDialog, to)) {
    return `Filled subject/body but Gmail did not accept the To address (${to}). Click the To field, paste the address, press Enter, then Send. ${summary}`;
  }

  const sendScope = resolvedDialog;
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

function parseGmailSearchQuery(task: string): string {
  const t = task.trim();
  const patterns: RegExp[] = [
    /\b(?:search|find|show)\s+(?:my\s+)?(?:mail|inbox|gmail)\s+for\s+(.+)/i,
    /\b(?:search|find)\s+(?:my\s+)?(?:mail|inbox)\s+(?:for\s+)?(.+)/i,
    /\bgmail\s+search\s+(?:for\s+)?(.+)/i,
    /\bopen\s+(?:the\s+)?(?:email|message)\s+(?:from|about|for|with)\s+(.+)/i,
    /\bin\s+(?:my\s+)?(?:mail|inbox)\s+for\s+(.+)/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    const chunk = m?.[1]?.trim().replace(/[.!?]+$/, "").trim();
    if (chunk && chunk.length >= 1) return chunk;
  }
  const stripped = t
    .replace(/\b(search|find|show|look\s+up|open|my|the|mail|inbox|gmail|email|messages?|for)\s+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= 2 ? stripped : "in:inbox";
}

async function runGmailSearchAndOpen(task: string): Promise<string> {
  if (!window.location.hostname.includes("mail.google.com")) {
    window.location.assign("https://mail.google.com/mail/u/0/");
    return "Opening Gmail… Run the same command again after the page loads.";
  }

  const q = parseGmailSearchQuery(task);
  const nextHash = `search/${encodeURIComponent(q)}`;
  const cur = window.location.hash.replace(/^#/, "");
  if (cur !== nextHash) {
    window.location.hash = nextHash;
    await wait(3200);
  } else {
    await wait(450);
  }

  const main = document.querySelector<HTMLElement>('[role="main"]');
  const row =
    (main &&
      (main.querySelector<HTMLElement>("tr.zA") ??
        main.querySelector<HTMLElement>("tr[data-legacy-thread-id]"))) ??
    document.querySelector<HTMLElement>("tr.zA");

  if (row && row.offsetParent !== null) {
    const target = row.querySelector<HTMLElement>("a[href*='#inbox'], a[href*='#search'], .yW, .y6") ?? row;
    target.click();
    await wait(1400);
    return `Opened a message for “${q}”.`;
  }

  return `Search is set to “${q}”. No row matched yet — pick a message from the list or run again.`;
}

function runFoodOrder(task: string): string {
  const h = window.location.hostname;
  if (/ubereats\.com|doordash\.com|grubhub\.com/i.test(h)) {
    return "You’re on a food delivery site — select items or adjust the search in the page.";
  }
  const url = buildFoodOrderUrl(task);
  window.location.assign(url);
  const label = /\b(doordash|door\s*dash)\b/i.test(task)
    ? "DoorDash"
    : /\bgrubhub\b/i.test(task)
      ? "Grubhub"
      : "Uber Eats";
  return `Opening ${label}…`;
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

  if (isGmailMailSearchIntent(t)) {
    return runGmailSearchAndOpen(t);
  }

  if (isGmailFormalizeIntent(t)) {
    return runGmailFormalizeDraft(t);
  }

  if (isFoodOrderIntent(t)) {
    return runFoodOrder(t);
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

  return `No in-tab handler for this task yet. Try: send mail, search my mail, make this email formal, order food, or LinkedIn jobs. Task: ${t.slice(0, 100)}`;
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
