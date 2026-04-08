/**
 * Gmail subject + body via configured LLM (OpenRouter or Groq) — service worker only.
 */

import { chatCompletionContent, type LlmConfig } from "./llm-provider";

export type EmailDraft = { subject: string; body: string };

function extractJsonObject(raw: string): Record<string, unknown> {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fence ? fence[1]!.trim() : t;
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("No JSON object in model output");
  }
  return JSON.parse(payload.slice(start, end + 1)) as Record<string, unknown>;
}

function pickSubject(obj: Record<string, unknown>): string {
  for (const k of ["subject", "title", "email_subject"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function pickBody(obj: Record<string, unknown>): string {
  for (const k of ["body", "message", "email_body", "content", "text"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim().replace(/\\n/g, "\n");
    }
  }
  return "";
}

async function fetchBodyOnly(
  config: LlmConfig,
  ctx: { task: string; to?: string; subject: string },
): Promise<string> {
  const user = [
    `Instruction:\n${(ctx.task || "").trim().slice(0, 4000)}`,
    ctx.to?.trim() ? `To: ${ctx.to.trim()}` : "",
    `Subject line (for context only): ${ctx.subject.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const content = await chatCompletionContent(config, {
    messages: [
      {
        role: "system",
        content:
          "Write only the email message body. Plain text, no subject line, no HTML. At least 2 sentences. Use blank lines between paragraphs.",
      },
      { role: "user", content: user || "Write a short professional email." },
    ],
    max_tokens: 900,
    temperature: 0.45,
  });

  return content.replace(/\\n/g, "\n");
}

const DEFAULT_COMPOSE_SYSTEM = `You compose Gmail emails. Reply with a single JSON object only (no markdown), exactly two string keys: "subject" and "body".

Both keys MUST be present as strings.
- "subject": one line, max 14 words, professional (or copy exact text if user provided a subject).
- "body": full email in plain text only; at least 2 sentences; use newline characters between paragraphs; no HTML; never leave "body" as an empty string when the user did not supply a body.`;

const FORMALIZE_SYSTEM = `You rewrite informal or messy Gmail drafts into clear, professional business email. Reply with a single JSON object only (no markdown), exactly two string keys: "subject" and "body".

Both keys MUST be non-empty strings when there is any usable content in the draft.
- Expand slang and shorthand (e.g. tmrw → tomorrow, u → you if it appears).
- Remove accidental duplication (e.g. the same phrase pasted twice); merge into one clean subject and one coherent body.
- "subject": one professional line, max 16 words.
- "body": plain text only; polite greeting and closing if appropriate; use newline characters between short paragraphs; no HTML; do not invent names, dates, or meeting times—only clarify wording around what the user wrote.
- If subject is empty but body has content, derive a subject. If body is empty but subject has content, write a brief formal body that matches the subject.`;

async function fetchEmailJson(
  config: LlmConfig,
  useJsonFormat: boolean,
  userContent: string,
  systemPrompt: string = DEFAULT_COMPOSE_SYSTEM,
): Promise<EmailDraft> {
  const raw = await chatCompletionContent(config, {
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      { role: "user", content: userContent.slice(0, 12_000) },
    ],
    max_tokens: 2048,
    temperature: 0.45,
    ...(useJsonFormat ? { response_format: { type: "json_object" as const } } : {}),
  });

  const obj = extractJsonObject(raw);
  const subject = pickSubject(obj);
  let bodyStr = pickBody(obj);
  if (!subject && !bodyStr) {
    throw new Error("Empty subject and body from model");
  }
  return { subject, body: bodyStr };
}

/**
 * Fills missing subject and/or body. Preserves non-empty subject/body from the user.
 */
export async function generateEmailDraftWithGroq(
  config: LlmConfig,
  input: { task: string; to?: string; subject?: string; body?: string },
): Promise<EmailDraft> {
  const hasSubject = Boolean(input.subject?.trim());
  const hasBody = Boolean(input.body?.trim());

  const userParts: string[] = [
    `Full user instruction:\n${(input.task || "").trim()}`,
    input.to?.trim() ? `Recipient:\n${input.to.trim()}` : "Recipient: (not given — use a neutral greeting if needed)",
  ];
  if (hasSubject) {
    userParts.push(`ALREADY CHOSEN SUBJECT (copy exactly into JSON "subject"):\n${input.subject!.trim()}`);
  } else {
    userParts.push("Subject: MISSING — you must write a non-empty subject.");
  }
  if (hasBody) {
    userParts.push(`ALREADY DRAFTED BODY (copy exactly into JSON "body"):\n${input.body!.trim()}`);
  } else {
    userParts.push(
      "Body: MISSING — you must write a complete non-empty email body (multiple sentences). JSON field \"body\" must not be \"\".",
    );
  }

  const userContent = userParts.join("\n\n---\n\n");

  let draft: EmailDraft;
  try {
    draft = await fetchEmailJson(config, true, userContent);
  } catch {
    draft = await fetchEmailJson(config, false, userContent);
  }

  let subject = hasSubject ? input.subject!.trim() : draft.subject.trim();
  let bodyOut = hasBody ? input.body!.trim() : draft.body.trim();

  if (!hasBody && bodyOut.length < 25) {
    const subjForBody = subject || draft.subject.trim() || "Email";
    try {
      const extra = await fetchBodyOnly(config, {
        task: input.task,
        to: input.to,
        subject: subjForBody,
      });
      if (extra.length > 20) bodyOut = extra;
    } catch {
      /* keep short body */
    }
  }

  if (!hasSubject && !subject && bodyOut) {
    subject = bodyOut.split(/\n/)[0]!.trim().slice(0, 78);
  }

  return { subject, body: bodyOut };
}

/**
 * Turn the current informal compose subject/body into a formal draft (replaces content).
 */
export async function formalizeEmailDraftWithGroq(
  config: LlmConfig,
  input: { subject: string; body: string; task?: string },
): Promise<EmailDraft> {
  const sub = (input.subject || "").trim();
  const bod = (input.body || "").trim();
  if (!sub && !bod) {
    throw new Error("Nothing to rewrite — add a subject or body in the compose window.");
  }

  const userParts = [
    input.task?.trim() ? `User note:\n${input.task.trim().slice(0, 2000)}` : "",
    "---",
    `Current subject:\n${sub || "(empty)"}`,
    `Current body:\n${bod || "(empty)"}`,
    "---",
    'Return JSON only: {"subject":"...","body":"..."}',
  ].filter((p) => p.length > 0);

  const userContent = userParts.join("\n\n");

  try {
    return await fetchEmailJson(config, true, userContent, FORMALIZE_SYSTEM);
  } catch {
    return await fetchEmailJson(config, false, userContent, FORMALIZE_SYSTEM);
  }
}
