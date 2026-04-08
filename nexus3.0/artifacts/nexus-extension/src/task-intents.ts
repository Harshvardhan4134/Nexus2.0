/**
 * Shared task routing for background + content (keep patterns in sync).
 */

export function isEmailIntent(task: string): boolean {
  const t = task.trim();
  if (/send\s+(a\s+)?message\s+to\s+/i.test(t) && /@/.test(t)) return true;
  return [
    /send\s+(a\s+)?mail\b/i,
    /send\s+(an?\s+)?e\s*-?mail\b/i,
    /\bmail\s+to\s+[\w.+-]+@/i,
    /\bemail\s+to\s+[\w.+-]+@/i,
    /compose\s+(a\s+)?(mail|e\s*-?mail)\b/i,
    /write\s+(a\s+)?(mail|e\s*-?mail)\b/i,
    /draft\s+(a\s+)?(mail|e\s*-?mail)\b/i,
    /\bopen\s+gmail\b/i,
    /\bgmail\s+compose\b/i,
  ].some((p) => p.test(t));
}

/** True when the user clearly wants Gmail (not a vague phrase that could mean “apply”). */
export function clearlyWantsGmail(task: string): boolean {
  const t = task.trim();
  if (!isEmailIntent(t)) return false;
  if (/@/.test(t)) return true;
  if (/\b(send|compose|write|draft)\s+(a\s+|an\s+)?(e\s*-?mail|mail)\b/i.test(t)) return true;
  if (/\b(open\s+gmail|gmail\s+compose)\b/i.test(t)) return true;
  return false;
}

/** Show AI preamble in side panel before running tab (resume / profile / role ideas). */
export function shouldShowJobAssistPreamble(task: string): boolean {
  const t = task.trim();
  if (/^fill application form$/i.test(t)) return false;
  if (/\b(send|compose|write)\s+(a\s+|an\s+)?(e\s*-?mail|mail)\b/i.test(t) && /@/.test(t)) return false;
  return [
    /\bapply\s+for\s+(a\s+)?job\b/i,
    /\bjob\s+application\b/i,
    /\bhelp\s+me\s+(apply|get\s+a\s+job|find\s+a\s+job)\b/i,
    /\blooking\s+for\s+(a\s+)?job\b/i,
    /\bapply\s+for\s+this\s+(job|role|position)\b/i,
    /\bsearch\s+(for\s+)?jobs?\b/i,
    /\bfind\s+(me\s+)?(a\s+)?job\b/i,
    /\bget\s+hired\b/i,
    /\beasy\s+apply\b/i,
  ].some((p) => p.test(t));
}

export function isFillApplicationFormIntent(task: string): boolean {
  const t = task.trim();
  return [
    /\bfill\s+(?:out\s+)?(?:the\s+)?(?:application\s+)?form\b/i,
    /\bfill\s+(?:the\s+)?form\b/i,
    /\bfill\s+(?:this|it|these\s+fields)\b/i,
    /\bfill\s+(?:in\s+)?(?:my\s+)?details\b/i,
    /\bautofill\b/i,
    /\bpopulate\s+(?:the\s+)?form\b/i,
    /\bcomplete\s+(?:the\s+)?form\b/i,
    /\bautofill\s+(?:the\s+)?(?:application|job\s+application)\b/i,
    /\bcomplete\s+(?:my\s+)?(?:application\s+)?(?:details|fields)\b/i,
    /\bfill\s+(?:this\s+)?(?:page|screen)\b/i,
  ].some((p) => p.test(t));
}

/** Rewrite open compose draft to formal / professional (Groq). */
export function isGmailFormalizeIntent(task: string): boolean {
  const t = task.trim();
  if (/\b(send|compose)\s+(a\s+|an\s+)?(mail|e\s*-?mail)\s+to\s+[\w.+-]+@/i.test(t)) return false;
  return [
    /\b(formal|formalize)\s+(email|mail|draft|tone|version)\b/i,
    /\bprofessional\s+(email|mail|draft|tone)\b/i,
    /\brewrite\s+(the\s+)?(email|mail|draft|message)\b/i,
    /\bpolish\s+(the\s+)?(email|mail|draft)\b/i,
    /\bmake\s+(this\s+)?(email|mail|draft)\s+(formal|professional)\b/i,
    /\bprofessionalize\b/i,
    /\brephrase\s+(the\s+)?(email|mail|draft)\b/i,
    /\bfix\s+(the\s+)?(email|draft|wording)\b/i,
    /\bturn\s+this\s+into\s+(a\s+)?(formal|professional)\b/i,
  ].some((p) => p.test(t));
}

/** Search / find / open messages in Gmail (not compose). */
export function isGmailMailSearchIntent(task: string): boolean {
  const t = task.trim();
  if (/\b(send|compose|write|draft)\s+(a\s+|an\s+)?(e\s*-?mail|mail)\b/i.test(t)) return false;
  if (/\b(send|mail|email)\s+to\s+[\w.+-]+@/i.test(t)) return false;
  return [
    /\bsearch\s+(?:my\s+)?(?:mail|inbox|gmail)\b/i,
    /\b(find|look\s+up)\s+(?:an?\s+)?(?:email|message)s?\b/i,
    /\bgmail\s+search\b/i,
    /\bshow\s+(?:me\s+)?(?:emails|messages|mail)\b/i,
    /\bin\s+(?:my\s+)?(?:mail|inbox)\s+for\b/i,
    /\bopen\s+(?:the\s+)?(?:email|message)\s+(?:from|about|for|with)\b/i,
  ].some((p) => p.test(t));
}

/** Food / delivery — opens Uber Eats or DoorDash search (in-tab). */
export function isFoodOrderIntent(task: string): boolean {
  const t = task.trim();
  return [
    /\border\s+food\b/i,
    /\bget\s+food\b/i,
    /\bfood\s+delivery\b/i,
    /\b(order|get)\s+(?:some\s+)?(?:takeout|take-out)\b/i,
    /\b(ubereats|uber\s+eats|doordash|door\s*dash|grubhub)\b/i,
    /\border\s+(?:some\s+)?(?:pizza|sushi|burger|burrito|thai|chinese|indian)\b/i,
  ].some((p) => p.test(t));
}

/**
 * Uber Eats or DoorDash URL with a best-effort query from natural language.
 */
export function buildFoodOrderUrl(task: string): string {
  const t = task.trim();
  const useGh = /\bgrubhub\b/i.test(t);
  const useDd = /\b(doordash|door\s*dash)\b/i.test(t);
  let q = t
    .replace(/\b(please|can you|could you|i want to|i need to)\s+/gi, "")
    .replace(/\border\s+food\s*/gi, "")
    .replace(/\bget\s+food\s*/gi, "")
    .replace(/\bfood\s+delivery\s*/gi, "")
    .replace(/\b(order|get|buy)\s+(?:some\s+)?(?:takeout|take-out)\s*/gi, "")
    .replace(/\b(from|on|via)\s+(uber\s*eats?|ubereats|doordash|door\s*dash|grubhub)\b/gi, "")
    .replace(/\b(ubereats|uber\s+eats|doordash|door\s*dash|grubhub)\b/gi, "")
    .trim();

  if (q.length < 2) q = "restaurants";

  if (useGh) {
    return `https://www.grubhub.com/search?queryText=${encodeURIComponent(q)}`;
  }
  if (useDd) {
    return `https://www.doordash.com/search?query=${encodeURIComponent(q)}`;
  }
  return `https://www.ubereats.com/search?q=${encodeURIComponent(q)}`;
}

export function isJobIntent(task: string): boolean {
  const t = task.trim();
  return [
    /\bapply\s+for\b[\s\w,'+.-]*\bjobs?\b/i,
    /\bapply\s+to\b[\s\w,'+.-]*\bjobs?\b/i,
    /\bapply\s+for\b[\s\w,'+.-]{0,160}\blinkedin\b/i,
    /\bjob\s+applications?\b/i,
    /\bjob\s+application\b/i,
    /apply\s+on\s+linkedin/i,
    /\beasy\s+apply\b/i,
    /\bapply\s+for\s+this\s+(?:job|role|position)\b/i,
    /\bsearch\s+(?:for\s+)?jobs?\b/i,
    /\bfind\s+(?:me\s+)?jobs?\b/i,
    /\blooking\s+for\s+(?:a\s+)?[\s\w,'+.-]*\bjobs?\b/i,
  ].some((p) => p.test(t));
}
