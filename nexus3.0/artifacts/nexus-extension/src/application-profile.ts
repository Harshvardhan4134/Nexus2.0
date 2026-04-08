/** Stored job-application answers (Workday, Greenhouse, etc.). */

export const APPLICATION_PROFILE_STORAGE_KEY = "nexusApplicationProfile";
/** Base64 resume payload `{ name, mime, base64 }` for ATS uploads. */
export const RESUME_STORAGE_KEY = "nexusResume";
/** @deprecated Legacy single key; migrated into Groq field on next save. */
export const BYOK_STORAGE_KEY = "nexusByokApiKey";
/** Groq API key for LLM calls when wired to the Nexus API. */
export const BYOK_GROQ_STORAGE_KEY = "nexusByokGroqApiKey";
/** OpenRouter API key — preferred for LLM tasks when set (intent / drafts / job assist). */
export const BYOK_OPENROUTER_STORAGE_KEY = "nexusByokOpenrouterApiKey";
/** Optional model id (e.g. openai/gpt-4o-mini). Empty = default in extension. */
export const BYOK_OPENROUTER_MODEL_KEY = "nexusByokOpenrouterModel";
/** TinyFish API key for managed cloud browser (when the backend uses TinyFish). */
export const BYOK_TINYFISH_STORAGE_KEY = "nexusByokTinyfishApiKey";
/** `{ ts: number; message: string; level?: string }[]` newest first. */
export const ACTIVITY_LOG_KEY = "nexusActivityLogs";
/** Saved site credentials for TinyFish auto-login `{ gmailEmail, gmailPassword, linkedinEmail, linkedinPassword }`. */
export const SITE_CREDS_STORAGE_KEY = "nexusSiteCreds";
/** Plain text extracted from the uploaded resume — used as profile data for form-filling. */
export const RESUME_TEXT_STORAGE_KEY = "nexusResumeText";

export type ApplicationProfile = {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  linkedInUrl: string;
  portfolioUrl: string;
  currentEmployer: string;
  currentJobTitle: string;
};

export function defaultApplicationProfile(): ApplicationProfile {
  return {
    fullName: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    streetAddress: "",
    city: "",
    state: "",
    zipCode: "",
    country: "",
    linkedInUrl: "",
    portfolioUrl: "",
    currentEmployer: "",
    currentJobTitle: "",
  };
}

export function mergeDerivedNames(p: ApplicationProfile): ApplicationProfile {
  const out = { ...p };
  const fn = out.firstName.trim();
  const ln = out.lastName.trim();
  const full = out.fullName.trim();
  if (!fn && !ln && full) {
    const parts = full.split(/\s+/).filter(Boolean);
    out.firstName = parts[0] ?? "";
    out.lastName = parts.slice(1).join(" ");
  } else if (!full && (fn || ln)) {
    out.fullName = [fn, ln].filter(Boolean).join(" ").trim();
  }
  return out;
}
