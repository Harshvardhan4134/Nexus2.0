/**
 * Side-panel job / apply assistant — short LLM reply (service worker only).
 */

import { chatCompletionContent, type LlmConfig } from "./llm-provider";

export type JobAssistInput = {
  task: string;
  hasResume: boolean;
  hasProfile: boolean;
  /** Short hint, e.g. current title / employer from profile */
  profileHint: string;
};

export async function generateJobApplyAssistantReply(config: LlmConfig, input: JobAssistInput): Promise<string> {
  const user = [
    `User message: ${(input.task || "").trim().slice(0, 2000)}`,
    `Resume uploaded in Nexus sidebar: ${input.hasResume ? "yes" : "no — user should use the + button to attach a PDF/DOC"}`,
    `Application profile (name/email/phone) saved: ${input.hasProfile ? "yes" : "no — user should open the menu (☰) and fill Application profile, then Save"}`,
    input.profileHint ? `Saved profile context: ${input.profileHint}` : "",
    "",
    "Respond in plain text (no markdown fences). Under 900 characters.",
    "Structure:",
    "1) One short greeting.",
    "2) If resume or profile is missing, say exactly what to do next in one sentence each.",
    "3) Suggest 2–4 specific job titles or search directions that match what they asked (if vague, suggest sensible categories).",
    "4) One line: on a job posting page, use the preset “Fill application form” or say that phrase so Nexus can fill visible fields; they must review before Submit.",
  ]
    .filter((x) => x.length > 0)
    .join("\n");

  const raw = await chatCompletionContent(config, {
    messages: [
      {
        role: "system",
        content:
          "You are Nexus, a concise career helper inside a Chrome extension. Be practical and friendly. Never promise automatic job submission or guaranteed interviews.",
      },
      { role: "user", content: user },
    ],
    max_tokens: 700,
    temperature: 0.5,
  });

  if (!raw) throw new Error("Empty assistant reply");
  return raw.slice(0, 2000);
}
