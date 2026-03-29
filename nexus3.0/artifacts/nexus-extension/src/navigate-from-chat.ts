/**
 * Detect https URLs in chat and decide whether to navigate the tab before running automation.
 */

import { isEmailIntent } from "./task-intents";

export function extractHttpUrl(task: string): string | null {
  const m = task.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  let s = m[0].replace(/[),.;:!?]+$/g, "");
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

function looksLikeJobOrApplicationUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    const full = `${h}${u.pathname}`.toLowerCase();
    if (/myworkdayjobs\.|\.myworkday\.|\.wd[0-9]+\.myworkday/.test(h)) return true;
    if (
      /greenhouse\.io|boards\.greenhouse|lever\.co|jobs\.lever|smartrecruiters\.com|ashbyhq\.com|icims\.com|bamboohr\.com|taleo|eightfold\.ai|applytojob\.com|jobvite\.com|workable\.com|breezy\.hr/i.test(
        h,
      )
    )
      return true;
    if (/\/(apply|application|careers?\/apply|jobs?\/apply)\b/i.test(u.pathname)) return true;
    if (/\bjobs?\b/i.test(u.pathname) && /\.(com|io|jobs)\b/i.test(h)) return true;
    if (/linkedin\.com\/jobs\//i.test(full)) return true;
    return false;
  } catch {
    return false;
  }
}

/** True when we should navigate the active tab to the URL, then run fill / LinkedIn (not plain email tasks). */
export function shouldNavigateFromChatToUrl(task: string, url: string): boolean {
  if (isEmailIntent(task)) return false;
  const t = task.trim();
  const urlOnly = /^https?:\/\/\S+$/i.test(t.replace(/[),.;:!?]+$/, ""));
  if (urlOnly) return true;
  if (/\b(fill|open|apply|complete|visit|goto|go\s+to|navigate|load|run)\b/i.test(t)) return true;
  if (looksLikeJobOrApplicationUrl(url)) return true;
  return false;
}
