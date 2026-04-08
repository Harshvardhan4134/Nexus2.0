/**
 * Routes LLM calls to OpenRouter (preferred) or Groq — OpenAI-compatible chat completions.
 */

import {
  BYOK_GROQ_STORAGE_KEY,
  BYOK_OPENROUTER_MODEL_KEY,
  BYOK_OPENROUTER_STORAGE_KEY,
  BYOK_STORAGE_KEY,
} from "./application-profile";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_DEFAULT_MODEL = "llama-3.1-8b-instant";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o-mini";

export type LlmProviderKind = "openrouter" | "groq";

export type LlmConfig = {
  provider: LlmProviderKind;
  apiKey: string;
  model: string;
  chatUrl: string;
};

type StorageLike = Record<string, unknown>;

/**
 * Prefer OpenRouter when its key is set (better intent understanding); else Groq / legacy key.
 */
export function buildLlmConfigFromStored(stored: StorageLike): LlmConfig | null {
  const orKey =
    typeof stored[BYOK_OPENROUTER_STORAGE_KEY] === "string"
      ? (stored[BYOK_OPENROUTER_STORAGE_KEY] as string).trim()
      : "";
  if (orKey) {
    const rawModel =
      typeof stored[BYOK_OPENROUTER_MODEL_KEY] === "string"
        ? (stored[BYOK_OPENROUTER_MODEL_KEY] as string).trim()
        : "";
    const model = rawModel || OPENROUTER_DEFAULT_MODEL;
    return {
      provider: "openrouter",
      apiKey: orKey,
      model,
      chatUrl: OPENROUTER_CHAT_URL,
    };
  }

  const groq =
    typeof stored[BYOK_GROQ_STORAGE_KEY] === "string" ? (stored[BYOK_GROQ_STORAGE_KEY] as string).trim() : "";
  const legacy = typeof stored[BYOK_STORAGE_KEY] === "string" ? (stored[BYOK_STORAGE_KEY] as string).trim() : "";
  const key = groq || legacy;
  if (!key) return null;

  return {
    provider: "groq",
    apiKey: key,
    model: GROQ_DEFAULT_MODEL,
    chatUrl: GROQ_CHAT_URL,
  };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatCompletionOptions = {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  /** OpenAI-style JSON mode (supported by many OpenRouter models) */
  response_format?: { type: "json_object" };
};

export async function chatCompletionContent(
  config: LlmConfig,
  opts: ChatCompletionOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: opts.messages,
    max_tokens: opts.max_tokens ?? 1024,
    temperature: opts.temperature ?? 0.45,
  };
  if (opts.response_format) {
    body.response_format = opts.response_format;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey.trim()}`,
    "Content-Type": "application/json",
  };
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://nexus-agent.local";
    headers["X-Title"] = "Nexus Agent (Chrome extension)";
  }

  const res = await fetch(config.chatUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    const label = config.provider === "openrouter" ? "OpenRouter" : "Groq";
    throw new Error(`${label} ${res.status}: ${errText.slice(0, 280)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}
