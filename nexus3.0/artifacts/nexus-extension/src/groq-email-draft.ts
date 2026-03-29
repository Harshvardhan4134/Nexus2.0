/**
 * Gmail subject + body via Groq (service worker only).
 */

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

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

async function fetchGroqBodyOnly(
  apiKey: string,
  ctx: { task: string; to?: string; subject: string },
): Promise<string> {
  const user = [
    `Instruction:\n${(ctx.task || "").trim().slice(0, 4000)}`,
    ctx.to?.trim() ? `To: ${ctx.to.trim()}` : "",
    `Subject line (for context only): ${ctx.subject.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
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
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Groq ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return (data.choices?.[0]?.message?.content ?? "").trim().replace(/\\n/g, "\n");
}

async function fetchGroqJson(
  apiKey: string,
  useJsonFormat: boolean,
  userContent: string,
): Promise<EmailDraft> {
  const body: Record<string, unknown> = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: `You compose Gmail emails. Reply with a single JSON object only (no markdown), exactly two string keys: "subject" and "body".

Both keys MUST be present as strings.
- "subject": one line, max 14 words, professional (or copy exact text if user provided a subject).
- "body": full email in plain text only; at least 2 sentences; use newline characters between paragraphs; no HTML; never leave "body" as an empty string when the user did not supply a body.`,
      },
      { role: "user", content: userContent.slice(0, 12_000) },
    ],
    max_tokens: 2048,
    temperature: 0.45,
  };
  if (useJsonFormat) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Groq ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
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
  apiKey: string,
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
    draft = await fetchGroqJson(apiKey, true, userContent);
  } catch {
    draft = await fetchGroqJson(apiKey, false, userContent);
  }

  let subject = hasSubject ? input.subject!.trim() : draft.subject.trim();
  let bodyOut = hasBody ? input.body!.trim() : draft.body.trim();

  if (!hasBody && bodyOut.length < 25) {
    const subjForBody = subject || draft.subject.trim() || "Email";
    try {
      const extra = await fetchGroqBodyOnly(apiKey, {
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
