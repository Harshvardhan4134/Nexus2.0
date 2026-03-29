/**
 * Extract recipient, subject, and body from natural chat text (Gmail compose).
 */

function stripLeadingPhrases(s: string): string {
  return s
    .replace(/^(please\s+)?(can you\s+|could you\s+|would you\s+)?/i, "")
    .replace(/^i\s+(want|need)\s+to\s+/i, "")
    .replace(
      /^send\s+(?:a\s+)?(?:an\s+)?(?:e\s*-?mail|mail)\s*(?:to\s+)?/i,
      "",
    )
    .replace(/^compose\s+(?:a\s+)?(?:an\s+)?(?:e\s*-?mail|mail)\s*/i, "")
    .replace(/^write\s+(?:a\s+)?(?:an\s+)?(?:e\s*-?mail|mail)\s*/i, "")
    .replace(/^draft\s+(?:a\s+)?(?:an\s+)?(?:e\s*-?mail|mail)\s*/i, "")
    .trim();
}

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;

export function parseEmailParts(task: string): { to?: string; subject?: string; body?: string } {
  const raw = task.trim();
  let working = stripLeadingPhrases(raw);

  const emails = [...working.matchAll(EMAIL_RE)].map((m) => m[0]);
  const isNoise = (e: string) =>
    /^(noreply|no-reply|donotreply|mailer-daemon)@/i.test(e);

  let to: string | undefined;
  const angle = working.match(/<([\w.+-]+@[\w.-]+\.[a-z]{2,})>/i);
  if (angle) {
    to = angle[1];
  }
  if (!to) {
    const explicitTo = working.match(
      /(?:^|[\s,;])(?:to|send\s+to|recipient|email|mail)\s*[:\s]+\s*([\w.+-]+@[\w.-]+\.[a-z]{2,})/i,
    );
    if (explicitTo) to = explicitTo[1];
  }
  if (!to) {
    const lead = working.match(/^[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    if (lead) to = lead[0];
    else {
      const good = emails.filter((e) => !isNoise(e));
      if (good.length >= 1) to = good[0];
    }
  }

  let subject: string | undefined;
  const subjColon = working.match(
    /\bsubject\s*[:\-–]\s*(.+?)(?=\n|\s+(?:body|message|saying|that\s+says|text\s*[:\-]|with\s+the\s+message)\b|$)/is,
  );
  if (subjColon) subject = subjColon[1].trim().replace(/^["']|["']$/g, "");
  if (!subject) {
    const ab = working.match(
      /\b(?:about|regarding|re)\s*[:\-–]\s*(.+?)(?=\n|\s+(?:body|message|saying|that\s+says|text\s*[:\-]|with\s+the\s+message)\b|$)/is,
    );
    if (ab) subject = ab[1].trim().replace(/^["']|["']$/g, "");
  }

  let body: string | undefined;
  const bodyPatterns: RegExp[] = [
    /\b(?:body|message|content)\s*[:\-–]\s*([\s\S]+)/i,
    /\btext\s*[:\-–]\s*([\s\S]+)/i,
    /\b(?:saying|that\s+says)\s*[:\s,]+([\s\S]+)/i,
    /\bwith\s+(?:the\s+)?(?:message|text)\s*[:\s,]+([\s\S]+)/i,
    /\b(?:write|tell\s+them)\s*[:\s,]+([\s\S]+)/i,
  ];
  for (const p of bodyPatterns) {
    const m = working.match(p);
    if (m?.[1]) {
      body = m[1].trim();
      break;
    }
  }

  if (!body) {
    let rest = stripLeadingPhrases(working);
    if (to) rest = rest.replace(new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    rest = rest
      .replace(/<[\w.+-]+@[\w.-]+\.[a-z]{2,}>/gi, " ")
      .replace(/\bsubject\s*[:\-–][\s\S]+?(?=\s{2,}|$)/i, " ")
      .replace(/\b(?:about|regarding|re)\s*[:\-–][\s\S]+?(?=\s{2,}|$)/i, " ")
      .replace(/\b(?:to|recipient)\s*[:\-–]\s*[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
      .replace(/\bto\s*[:\-–]\s*[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    rest = rest.replace(/^[,;:\-\s]+/, "").trim();
    if (rest.length >= 5 && !/^(subject|to|body|message)\b/i.test(rest)) {
      body = rest;
    }
  }

  if (body) {
    body = body
      .replace(/\b(send\s+it|send\s+now|dispatch\s+it|and\s+send)\s*$/i, "")
      .replace(/^["']|["']$/g, "")
      .trim();
  }

  if (body && subject) {
    const bn = body.toLowerCase();
    const sn = subject.toLowerCase();
    if (bn.startsWith(sn)) {
      const rest = body.slice(subject.length).replace(/^[,;:\s\-–]+/, "").trim();
      if (rest.length >= 3) body = rest;
    }
  }

  return { to, subject, body };
}

/**
 * Whether to click Send after filling compose. Matches earlier behavior: send by default;
 * only skip when the user explicitly asks for a draft only.
 */
export function shouldAutoSendEmail(task: string, _parts: { to?: string; subject?: string; body?: string }): boolean {
  if (/\b(don'?t\s+send|do\s+not\s+send|only\s+compose|just\s+draft|no\s+send)\b/i.test(task)) {
    return false;
  }
  return true;
}
