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
