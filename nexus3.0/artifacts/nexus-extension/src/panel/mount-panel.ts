import {
  ACTIVITY_LOG_KEY,
  APPLICATION_PROFILE_STORAGE_KEY,
  BYOK_GROQ_STORAGE_KEY,
  BYOK_OPENROUTER_MODEL_KEY,
  BYOK_OPENROUTER_STORAGE_KEY,
  BYOK_STORAGE_KEY,
  BYOK_TINYFISH_STORAGE_KEY,
  RESUME_STORAGE_KEY,
  RESUME_TEXT_STORAGE_KEY,
  SITE_CREDS_STORAGE_KEY,
  defaultApplicationProfile,
  type ApplicationProfile,
} from "../application-profile";
import { shouldShowJobAssistPreamble } from "../task-intents";

type StepState = "loading" | "done" | "error" | "pending";
type Step = { text: string; state: StepState };
type LogEntry = { ts: number; message: string };

const MAX_RESUME_BYTES = 1_500_000;
const MAX_LOG_ENTRIES = 80;

const FIELD_IDS: [keyof ApplicationProfile, string][] = [
  ["firstName", "pf-firstName"],
  ["lastName", "pf-lastName"],
  ["fullName", "pf-fullName"],
  ["email", "pf-email"],
  ["phone", "pf-phone"],
  ["streetAddress", "pf-street"],
  ["city", "pf-city"],
  ["state", "pf-state"],
  ["zipCode", "pf-zip"],
  ["country", "pf-country"],
  ["linkedInUrl", "pf-linkedin"],
  ["portfolioUrl", "pf-portfolio"],
  ["currentEmployer", "pf-employer"],
  ["currentJobTitle", "pf-jobtitle"],
];

/** Shared UI logic for Chrome side panel (and popup if needed). */
export function mountNexusPanel(): void {
  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
  const btnSend = document.getElementById("btn-send") as HTMLButtonElement;
  const btnMenu = document.getElementById("btn-menu") as HTMLButtonElement;
  const btnLogs = document.getElementById("btn-logs") as HTMLButtonElement;
  const btnAttach = document.getElementById("btn-attach") as HTMLButtonElement;
  const btnGlobe = document.getElementById("btn-globe") as HTMLButtonElement;
  const fileResume = document.getElementById("file-resume") as HTMLInputElement;
  const resumeStatus = document.getElementById("resume-status") as HTMLDivElement;
  const backdrop = document.getElementById("backdrop") as HTMLDivElement;
  const drawerMenu = document.getElementById("drawer-menu") as HTMLElement;
  const drawerLogs = document.getElementById("drawer-logs") as HTMLElement;
  const logList = document.getElementById("log-list") as HTMLUListElement;
  const clearLogsBtn = document.getElementById("clear-logs") as HTMLButtonElement;
  const taskCard = document.getElementById("task-card") as HTMLElement;
  const taskTitleEl = document.getElementById("task-title") as HTMLElement;
  const taskStepsEl = document.getElementById("task-steps") as HTMLUListElement;
  const saveProfileBtn = document.getElementById("save-profile") as HTMLButtonElement;
  const autofillFromResumeBtn = document.getElementById("autofill-from-resume") as HTMLButtonElement;
  const autofillStatus = document.getElementById("autofill-status") as HTMLParagraphElement;
  const saveByokBtn = document.getElementById("save-byok") as HTMLButtonElement;
  const byokOpenrouterInput = document.getElementById("byok-openrouter") as HTMLInputElement;
  const byokOpenrouterModelInput = document.getElementById("byok-openrouter-model") as HTMLInputElement;
  const byokGroqInput = document.getElementById("byok-groq") as HTMLInputElement;
  const byokTinyfishInput = document.getElementById("byok-tinyfish") as HTMLInputElement;
  const byokLlmStatus = document.getElementById("byok-llm-status") as HTMLParagraphElement | null;
  const savedGmailEmail = document.getElementById("saved-gmail-email") as HTMLInputElement;
  const savedMicrosoftEmail = document.getElementById("saved-microsoft-email") as HTMLInputElement;
  const savedMicrosoftPassword = document.getElementById("saved-microsoft-password") as HTMLInputElement;
  const savedGmailPassword = document.getElementById("saved-gmail-password") as HTMLInputElement;
  const savedLinkedinEmail = document.getElementById("saved-linkedin-email") as HTMLInputElement;
  const savedLinkedinPassword = document.getElementById("saved-linkedin-password") as HTMLInputElement;
  const savedSwiggyEmail = document.getElementById("saved-swiggy-email") as HTMLInputElement;
  const savedSwiggyPassword = document.getElementById("saved-swiggy-password") as HTMLInputElement;
  const savedZomatoEmail = document.getElementById("saved-zomato-email") as HTMLInputElement;
  const savedZomatoPassword = document.getElementById("saved-zomato-password") as HTMLInputElement;
  const saveSiteCredsBtn = document.getElementById("save-site-creds") as HTMLButtonElement;
  const siteCredsStatus = document.getElementById("site-creds-status") as HTMLParagraphElement;
  const pillFill = document.getElementById("pill-fill") as HTMLButtonElement;
  const pillCompose = document.getElementById("pill-compose") as HTMLButtonElement;
  const pillFormalize = document.getElementById("pill-formalize") as HTMLButtonElement;
  const pillSwiggy = document.getElementById("pill-swiggy") as HTMLButtonElement;
  const pillZomato = document.getElementById("pill-zomato") as HTMLButtonElement;
  const brandLogo = document.getElementById("brand-logo") as HTMLImageElement;
  const chatBox = document.querySelector(".chat-box") as HTMLElement;

  // TinyFish live view elements
  const tfCredEmail = document.getElementById("tf-cred-email") as HTMLInputElement;
  const tfCredPassword = document.getElementById("tf-cred-password") as HTMLInputElement;
  const tfCredStrip = document.getElementById("tf-cred-strip") as HTMLDivElement;
  const tfCredRetry = document.getElementById("tf-cred-retry") as HTMLButtonElement;
  const tfBtnCredsToggle = document.getElementById("tf-btn-creds-toggle") as HTMLButtonElement;
  const tfBtnFullview = document.getElementById("tf-btn-fullview") as HTMLButtonElement;
  const tfBtnStop = document.getElementById("tf-btn-stop") as HTMLButtonElement;
  let tfCurrentStreamingUrl: string | null = null;
  const tfLiveSection = document.getElementById("tf-live-section") as HTMLDivElement;
  const tfLiveDot = document.getElementById("tf-live-dot") as HTMLSpanElement;
  const tfLiveStatusText = document.getElementById("tf-live-status-text") as HTMLSpanElement;
  const tfLivePlaceholder = document.getElementById("tf-live-placeholder") as HTMLDivElement;
  const tfLiveIframe = document.getElementById("tf-live-iframe") as HTMLIFrameElement;
  const tfLiveLogs = document.getElementById("tf-live-logs") as HTMLDivElement;
  const tfResultCard = document.getElementById("tf-result-card") as HTMLDivElement;
  const tfResultTitle = document.getElementById("tf-result-title") as HTMLDivElement;
  const tfResultUrl = document.getElementById("tf-result-url") as HTMLDivElement;
  const tfResultActions = document.getElementById("tf-result-actions") as HTMLDivElement;
  const tfBtnOpen = document.getElementById("tf-btn-open") as HTMLButtonElement;
  const tfBtnCopy = document.getElementById("tf-btn-copy") as HTMLButtonElement;

  let running = false;
  let tfPollTimer: ReturnType<typeof setTimeout> | null = null;
  let tfCurrentRunId: string | null = null;
  let tfCurrentTask: string | null = null;

  function readProfileFromDom(): ApplicationProfile {
    const p = defaultApplicationProfile();
    for (const [key, id] of FIELD_IDS) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) p[key] = el.value as never;
    }
    return p;
  }

  function writeProfileToDom(profile: ApplicationProfile) {
    for (const [key, id] of FIELD_IDS) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = String(profile[key] ?? "");
    }
  }

  /** Parse a resume text blob into structured ApplicationProfile fields using regex patterns. */
  function parseResumeText(text: string): Partial<ApplicationProfile> {
    const lines = text.split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
    const result: Partial<ApplicationProfile> = {};

    // Email
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) result.email = emailMatch[0];

    // Phone — match international or local formats
    const phoneMatch = text.match(/(\+?\d[\d\s\-().]{7,15}\d)/);
    if (phoneMatch) result.phone = phoneMatch[0].replace(/\s+/g, " ").trim();

    // LinkedIn URL
    const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w%-]+/i);
    if (linkedinMatch) result.linkedInUrl = linkedinMatch[0].startsWith("http") ? linkedinMatch[0] : `https://${linkedinMatch[0]}`;

    // Portfolio / website (not LinkedIn)
    const webMatch = text.match(/(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|io|dev|me|co|in|net)\/[\w%-]+/i);
    if (webMatch && !/linkedin/i.test(webMatch[0])) {
      result.portfolioUrl = webMatch[0].startsWith("http") ? webMatch[0] : `https://${webMatch[0]}`;
    }

    // Name — first short line that doesn't look like a heading keyword or URL
    const skipWords = /^(resume|cv|curriculum|vitae|contact|profile|objective|summary|experience|education|skills|projects|email|phone|address|linkedin|github|http)/i;
    const nameLine = lines.find((l) => l.length > 2 && l.length < 60 && !skipWords.test(l) && !/[@/\\|•·]/.test(l) && /^[A-Za-z\s.'-]+$/.test(l));
    if (nameLine) {
      result.fullName = nameLine;
      const parts = nameLine.trim().split(/\s+/);
      result.firstName = parts[0] ?? "";
      result.lastName = parts.slice(1).join(" ");
    }

    // Current job title — look for common title patterns near the name
    const titlePatterns = /\b(engineer|developer|analyst|designer|manager|intern|architect|consultant|specialist|scientist|officer|lead|head|director|executive|associate|coordinator)\b/i;
    const titleLine = lines.find((l) => l.length < 80 && titlePatterns.test(l) && !skipWords.test(l));
    if (titleLine) result.currentJobTitle = titleLine;

    // Location — look for "City, State" or "City, Country" patterns
    const locationMatch = text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*([A-Z]{2,}|[A-Z][a-z]+)\b/);
    if (locationMatch) {
      result.city = locationMatch[1];
      result.state = locationMatch[2];
    }

    return result;
  }

  function loadProfile(): void {
    chrome.storage.local.get([APPLICATION_PROFILE_STORAGE_KEY], (r) => {
      const raw = r[APPLICATION_PROFILE_STORAGE_KEY];
      const base = defaultApplicationProfile();
      if (raw && typeof raw === "object") {
        Object.assign(base, raw as Partial<ApplicationProfile>);
      }
      writeProfileToDom(base);
    });
  }

  /** Debounced auto-save — fires 800ms after the last field change. */
  let profileAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleProfileAutoSave(): void {
    if (profileAutoSaveTimer) clearTimeout(profileAutoSaveTimer);
    profileAutoSaveTimer = setTimeout(() => {
      const p = readProfileFromDom();
      chrome.storage.local.set({ [APPLICATION_PROFILE_STORAGE_KEY]: p });
    }, 800);
  }

  function refreshByokLlmStatus(openrouter: string, groq: string, legacy: string): void {
    if (!byokLlmStatus) return;
    const or = openrouter.trim();
    const g = groq.trim() || legacy.trim();
    if (or) {
      byokLlmStatus.textContent =
        "Gmail (compose AI + formalize) and job assist will use OpenRouter. Click Save after changing keys.";
      return;
    }
    if (g) {
      byokLlmStatus.textContent =
        "Gmail (compose AI + formalize) and job assist will use Groq. Add OpenRouter above to switch.";
      return;
    }
    byokLlmStatus.textContent =
      "No LLM key yet — Gmail AI and job assist need an OpenRouter or Groq key, then Save.";
  }

  function loadSiteCreds(): void {
    chrome.storage.local.get([SITE_CREDS_STORAGE_KEY], (r) => {
      const c = r[SITE_CREDS_STORAGE_KEY] as Record<string, string> | undefined;
      if (!c) return;
      savedMicrosoftEmail.value = c.microsoftEmail ?? "";
      savedMicrosoftPassword.value = c.microsoftPassword ?? "";
      savedGmailEmail.value = c.gmailEmail ?? "";
      savedGmailPassword.value = c.gmailPassword ?? "";
      savedLinkedinEmail.value = c.linkedinEmail ?? "";
      savedLinkedinPassword.value = c.linkedinPassword ?? "";
      savedSwiggyEmail.value = c.swiggyEmail ?? "";
      savedSwiggyPassword.value = c.swiggyPassword ?? "";
      savedZomatoEmail.value = c.zomatoEmail ?? "";
      savedZomatoPassword.value = c.zomatoPassword ?? "";
      if (c.microsoftEmail || c.gmailEmail || c.linkedinEmail || c.swiggyEmail || c.zomatoEmail) {
        siteCredsStatus.textContent = "Credentials saved — TinyFish will use them automatically.";
      }
    });
  }

  function loadByok(): void {
    chrome.storage.local.get(
      [
        BYOK_OPENROUTER_STORAGE_KEY,
        BYOK_OPENROUTER_MODEL_KEY,
        BYOK_GROQ_STORAGE_KEY,
        BYOK_TINYFISH_STORAGE_KEY,
        BYOK_STORAGE_KEY,
      ],
      (r) => {
        const openrouter =
          typeof r[BYOK_OPENROUTER_STORAGE_KEY] === "string" ? r[BYOK_OPENROUTER_STORAGE_KEY] : "";
        const openrouterModel =
          typeof r[BYOK_OPENROUTER_MODEL_KEY] === "string" ? r[BYOK_OPENROUTER_MODEL_KEY] : "";
        const groq = typeof r[BYOK_GROQ_STORAGE_KEY] === "string" ? r[BYOK_GROQ_STORAGE_KEY] : "";
        const legacy = typeof r[BYOK_STORAGE_KEY] === "string" ? r[BYOK_STORAGE_KEY] : "";
        const tinyfish =
          typeof r[BYOK_TINYFISH_STORAGE_KEY] === "string" ? r[BYOK_TINYFISH_STORAGE_KEY] : "";
        byokOpenrouterInput.value = openrouter;
        byokOpenrouterModelInput.value = openrouterModel;
        byokGroqInput.value = groq || legacy;
        byokTinyfishInput.value = tinyfish;
        refreshByokLlmStatus(openrouter, groq, legacy);
      },
    );
  }

  function closeDrawers(): void {
    drawerMenu.classList.remove("open");
    drawerLogs.classList.remove("open");
    backdrop.classList.remove("on");
  }

  function openMenu(): void {
    closeDrawers();
    drawerMenu.classList.add("open");
    backdrop.classList.add("on");
  }

  function openLogsPanel(): void {
    closeDrawers();
    drawerLogs.classList.add("open");
    backdrop.classList.add("on");
    renderLogList();
  }

  function addLog(message: string): void {
    const entry: LogEntry = { ts: Date.now(), message };
    chrome.storage.local.get([ACTIVITY_LOG_KEY], (r) => {
      const arr: LogEntry[] = Array.isArray(r[ACTIVITY_LOG_KEY]) ? r[ACTIVITY_LOG_KEY] : [];
      arr.unshift(entry);
      chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: arr.slice(0, MAX_LOG_ENTRIES) }, () => {
        if (drawerLogs.classList.contains("open")) renderLogList();
      });
    });
  }

  function renderLogList(): void {
    chrome.storage.local.get([ACTIVITY_LOG_KEY], (r) => {
      const arr: LogEntry[] = Array.isArray(r[ACTIVITY_LOG_KEY]) ? r[ACTIVITY_LOG_KEY] : [];
      logList.innerHTML = "";
      for (const e of arr) {
        const li = document.createElement("li");
        li.className = "log-item";
        const t = document.createElement("time");
        t.dateTime = new Date(e.ts).toISOString();
        t.textContent = new Date(e.ts).toLocaleString();
        li.appendChild(t);
        li.appendChild(document.createTextNode(e.message));
        logList.appendChild(li);
      }
      if (arr.length === 0) {
        const li = document.createElement("li");
        li.className = "log-item";
        li.textContent = "No activity yet.";
        logList.appendChild(li);
      }
    });
  }

  function refreshResumeBadge(state: "loading" | "ready" | "error" | null = null): void {
    chrome.storage.local.get([RESUME_STORAGE_KEY], (r) => {
      const x = r[RESUME_STORAGE_KEY] as { name?: string } | undefined;
      resumeStatus.innerHTML = "";
      if (!x?.name) return;

      if (state === "loading") {
        resumeStatus.innerHTML = `<span class="spinner"></span><span style="font-size:10px;color:var(--muted)">Reading ${x.name}…</span>`;
        return;
      }

      const icon = state === "error" ? "⚠" : "📄";
      const color = state === "error" ? "var(--err)" : "var(--ok)";
      const span = document.createElement("span");
      span.textContent = `${icon} ${x.name}`;
      span.style.cssText = `font-size:10px;color:${color}`;

      if (state !== "error") {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "✕ Remove";
        removeBtn.style.cssText = "font-size:10px;background:none;border:none;color:var(--err);cursor:pointer;padding:0;margin-left:4px";
        removeBtn.addEventListener("click", () => {
          chrome.storage.local.remove([RESUME_STORAGE_KEY, RESUME_TEXT_STORAGE_KEY], () => {
            refreshResumeBadge();
            autofillStatus.textContent = "";
            addLog("Resume removed.");
          });
        });
        resumeStatus.appendChild(span);
        resumeStatus.appendChild(removeBtn);
      } else {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.textContent = "↺ Retry";
        retryBtn.style.cssText = "font-size:10px;background:none;border:none;color:var(--accent);cursor:pointer;padding:0;margin-left:4px";
        retryBtn.addEventListener("click", () => { autofillFromResumeBtn.click(); });
        resumeStatus.appendChild(span);
        resumeStatus.appendChild(retryBtn);
      }
    });
  }

  function setTaskTitle(text: string): void {
    taskTitleEl.textContent = text;
  }

  function renderTaskSteps(steps: Step[]): void {
    taskStepsEl.innerHTML = "";
    steps.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = `task-step ${s.state}`;
      li.style.animationDelay = `${i * 45}ms`;

      const ico = document.createElement("span");
      ico.className = "step-ico";
      if (s.state === "loading") {
        ico.classList.add("spinner");
      } else if (s.state === "done") {
        ico.classList.add("check");
        ico.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
      } else if (s.state === "error") {
        ico.classList.add("err");
        ico.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      } else {
        ico.classList.add("pending");
      }

      const span = document.createElement("span");
      span.className = "step-text";
      span.textContent = s.text;

      li.appendChild(ico);
      li.appendChild(span);
      taskStepsEl.appendChild(li);
    });
  }

  function finishRun(): void {
    running = false;
    btnSend.disabled = false;
    window.setTimeout(() => taskCard.classList.add("idle"), 2200);
  }

  function fetchJobAssistPreamble(task: string): Promise<string | null> {
    return new Promise((resolve) => {
      const p = readProfileFromDom();
      const hasProfile = Boolean(
        p.email?.trim() || p.fullName?.trim() || p.firstName?.trim(),
      );
      const profileHint = [p.currentJobTitle, p.currentEmployer].filter(Boolean).join(" · ").slice(0, 500);
      chrome.storage.local.get([RESUME_STORAGE_KEY], (r) => {
        const x = r[RESUME_STORAGE_KEY] as { name?: string } | undefined;
        const hasResume = Boolean(x?.name);
        chrome.runtime.sendMessage(
          {
            type: "JOB_ASSIST_REPLY",
            task,
            hasResume,
            hasProfile,
            profileHint,
          },
          (res: { ok?: boolean; text?: string } | undefined) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            if (res?.ok && res.text?.trim()) {
              resolve(res.text.trim());
              return;
            }
            resolve(null);
          },
        );
      });
    });
  }

  // ── TinyFish helpers ──────────────────────────────────────────────────────

  function extractUrl(task: string): string {
    const m = task.match(/https?:\/\/[^\s]+/i);
    return m ? m[0].replace(/[.,!?)]+$/, "") : "";
  }

  function isTinyFishTask(task: string): boolean {
    const t = task.trim();
    if (extractUrl(t)) return true;          // any URL → TinyFish fills/navigates
    if (/gmail|mail|e\s*-?mail|inbox|email/i.test(t)) return true;
    if (/linkedin/i.test(t)) return true;
    if (/\b(send|write|compose|draft)\s+(a\s+)?message\b/i.test(t)) return true;
    if (/\bmessage\s+[\w.+-]+@/i.test(t)) return true;
    if (/swiggy|zomato/i.test(t)) return true;
    if (/order\s+(food|pizza|biryani|burger|lunch|dinner|breakfast|meal|sushi|noodles)/i.test(t)) return true;
    if (/food\s+(delivery|order)|deliver\s+(food|meal)/i.test(t)) return true;
    if (/fill\s+(the\s+)?(form|application|survey)|submit\s+(the\s+)?form/i.test(t)) return true;
    return false;
  }

  function showTfLiveSection(): void {
    tfLiveSection.classList.remove("hidden");
    tfResultCard.classList.add("hidden");
    tfLiveDot.classList.remove("stopped");
    tfLiveStatusText.textContent = "TinyFish running…";
    tfLiveLogs.innerHTML = "";
    tfLivePlaceholder.classList.remove("hidden");
    tfLiveIframe.classList.add("hidden");
    tfLiveIframe.src = "";
    tfCredStrip.classList.add("hidden");
    tfBtnFullview.classList.add("hidden");
    removeInlineLoginPrompt();
    removeCaptchaBanner();
    tfCurrentStreamingUrl = null;
  }

  function appendTfLog(msg: string): void {
    const line = document.createElement("div");
    line.className = "tf-log-line";
    line.textContent = msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
    tfLiveLogs.appendChild(line);
    tfLiveLogs.scrollTop = tfLiveLogs.scrollHeight;
  }

  function stopTfPoll(): void {
    if (tfPollTimer !== null) {
      clearTimeout(tfPollTimer);
      tfPollTimer = null;
    }
    tfCurrentRunId = null;
  }

  function showTfResult(status: "completed" | "failed", resultUrl?: string, error?: string): void {
    tfLiveDot.classList.add("stopped");
    tfLiveStatusText.textContent = status === "completed" ? "TinyFish done" : "TinyFish failed";
    tfResultCard.classList.remove("hidden");

    if (status === "completed") {
      tfResultCard.classList.remove("failed");
      tfResultTitle.textContent = "Task completed";
      // Update task card steps so the header shows done (not still running)
      renderTaskSteps([
        { text: "TinyFish cloud run complete.", state: "done" },
        ...(resultUrl ? [{ text: `Result: ${resultUrl.slice(0, 60)}…`, state: "done" as const }] : []),
      ]);
    } else {
      tfResultCard.classList.add("failed");
      tfResultTitle.textContent = error ? `Failed: ${error.slice(0, 100)}` : "Task failed";
      renderTaskSteps([
        { text: error ?? "TinyFish could not complete the task.", state: "error" },
      ]);
    }

    if (resultUrl) {
      tfResultUrl.textContent = resultUrl;
      tfResultUrl.classList.remove("hidden");
      tfBtnOpen.classList.remove("hidden");
      tfBtnCopy.classList.remove("hidden");

      tfBtnOpen.onclick = () => {
        chrome.runtime.sendMessage({ type: "TINYFISH_OPEN_URL", url: resultUrl });
      };
      tfBtnCopy.onclick = () => {
        void navigator.clipboard.writeText(resultUrl).then(() => {
          tfBtnCopy.textContent = "Copied!";
          setTimeout(() => { tfBtnCopy.textContent = "Copy link"; }, 1800);
        });
      };

      chrome.runtime.sendMessage({ type: "TINYFISH_OPEN_URL", url: resultUrl });
    } else {
      tfResultUrl.classList.add("hidden");
      tfBtnOpen.classList.add("hidden");
      tfBtnCopy.classList.add("hidden");
    }
  }

  function showCaptchaBanner(): void {
    if (document.getElementById("tf-captcha-banner")) return;

    const li = document.createElement("li");
    li.id = "tf-captcha-banner";
    li.className = "task-step loading";
    li.style.cssText = "display:block;padding:10px 0 6px";

    li.innerHTML = `
      <div style="font-size:11px;color:#f59e0b;font-weight:700;margin-bottom:6px">
        ⚠ CAPTCHA detected — solve it in the full view tab
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:10px;line-height:1.5">
        TinyFish is waiting. Open the full view tab, solve the CAPTCHA, then TinyFish will continue automatically.
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button id="tf-captcha-fullview" type="button"
          style="padding:7px 14px;border-radius:8px;background:var(--accent);border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer">
          Open full view
        </button>
        <span id="tf-captcha-timer" style="font-size:10px;color:var(--muted)">Waiting for you…</span>
      </div>`;

    taskStepsEl.appendChild(li);

    document.getElementById("tf-captcha-fullview")?.addEventListener("click", () => {
      if (tfCurrentStreamingUrl) {
        chrome.runtime.sendMessage({ type: "TINYFISH_OPEN_URL", url: tfCurrentStreamingUrl });
      }
    });

    // Start a 2-minute countdown — after which TinyFish likely timed out anyway
    let secs = 120;
    const timerEl = document.getElementById("tf-captcha-timer");
    const countdown = setInterval(() => {
      secs--;
      if (timerEl) timerEl.textContent = `TinyFish waiting… ${secs}s`;
      if (secs <= 0) {
        clearInterval(countdown);
        if (timerEl) timerEl.textContent = "Time may have run out — check live view.";
      }
    }, 1000);

    // Store interval id so we can clear it when run ends
    li.dataset.countdownId = String(countdown);
  }

  function removeCaptchaBanner(): void {
    const el = document.getElementById("tf-captcha-banner");
    if (el) {
      const id = Number(el.dataset.countdownId);
      if (id) clearInterval(id);
      el.remove();
    }
  }

  function showCaptchaRetryCard(): void {
    const li = document.createElement("li");
    li.id = "tf-captcha-retry";
    li.className = "task-step error";
    li.style.cssText = "display:block;padding:10px 0 6px";

    li.innerHTML = `
      <div style="font-size:11px;color:#f59e0b;font-weight:700;margin-bottom:4px">
        ⚠ Session ended — CAPTCHA blocked the run
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:10px;line-height:1.5">
        Retrying via Google Search to avoid LinkedIn bot detection.
        Auto-retrying in
        <span id="tf-retry-countdown" style="color:var(--text);font-weight:700">45s</span>…
      </div>
      <div style="display:flex;gap:8px">
        <button id="tf-captcha-retry-now" type="button"
          style="padding:7px 14px;border-radius:8px;background:var(--accent);border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer">
          Retry now
        </button>
        <button id="tf-captcha-retry-cancel" type="button"
          style="padding:7px 12px;border-radius:8px;background:transparent;border:1px solid var(--border);color:var(--muted);font-size:11px;cursor:pointer">
          Cancel
        </button>
      </div>`;

    taskStepsEl.appendChild(li);

    let secs = 45;
    const countdownEl = document.getElementById("tf-retry-countdown");

    const doRetry = () => {
      clearInterval(tick);
      li.remove();
      void startTinyFishRun(tfCurrentTask ?? "", "", "", true);
    };

    const tick = setInterval(() => {
      secs--;
      if (countdownEl) countdownEl.textContent = `${secs}s`;
      if (secs <= 0) doRetry();
    }, 1000);

    document.getElementById("tf-captcha-retry-now")?.addEventListener("click", doRetry);
    document.getElementById("tf-captcha-retry-cancel")?.addEventListener("click", () => {
      clearInterval(tick);
      li.remove();
      renderTaskSteps([{ text: "Retry cancelled.", state: "error" }]);
    });
  }

  function showInlineLoginPrompt(): void {
    if (document.getElementById("tf-inline-login")) return;

    chrome.storage.local.get([SITE_CREDS_STORAGE_KEY], (r) => {
      const c = r[SITE_CREDS_STORAGE_KEY] as Record<string, string> | undefined;
      const task = tfCurrentTask ?? "";
      const detectedUrl = extractUrl(task);
      const isMsForm = /forms\.office\.com|forms\.microsoft\.com/i.test(detectedUrl);
      const isLinkedIn = /linkedin/i.test(task);
      const isSwiggy = /swiggy/i.test(task);
      const isZomato = /zomato/i.test(task);

      let prefillEmail = "";
      let prefillPass = "";
      if (c) {
        if (isMsForm)       { prefillEmail = c.microsoftEmail ?? ""; prefillPass = c.microsoftPassword ?? ""; }
        else if (isLinkedIn){ prefillEmail = c.linkedinEmail  ?? ""; prefillPass = c.linkedinPassword  ?? ""; }
        else if (isSwiggy)  { prefillEmail = c.swiggyEmail    ?? ""; prefillPass = c.swiggyPassword    ?? ""; }
        else if (isZomato)  { prefillEmail = c.zomatoEmail    ?? ""; prefillPass = c.zomatoPassword    ?? ""; }
        else                { prefillEmail = c.gmailEmail     ?? ""; prefillPass = c.gmailPassword     ?? ""; }
      }
      _buildInlineLoginPrompt(prefillEmail, prefillPass);
    });
  }

  function _buildInlineLoginPrompt(prefillEmail: string, prefillPass: string): void {
    if (document.getElementById("tf-inline-login")) return;

    const li = document.createElement("li");
    li.id = "tf-inline-login";
    li.className = "task-step loading";
    li.style.cssText = "display:block;padding:10px 0 6px";

    li.innerHTML = `
      <div style="font-size:11px;color:var(--accent-bright);font-weight:600;margin-bottom:4px">
        TinyFish needs to log in — enter your credentials:
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:8px">
        Tip: Use a <strong style="color:var(--text)">Google App Password</strong> to skip 2FA every time.
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <input id="tf-inline-email" type="email" placeholder="your@email.com" value="${prefillEmail}"
          style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:12px;width:100%;box-sizing:border-box" />
        <input id="tf-inline-password" type="password" placeholder="Password or App Password" value="${prefillPass}"
          style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:12px;width:100%;box-sizing:border-box" />
        <label style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--muted);cursor:pointer">
          <input id="tf-inline-save" type="checkbox" checked style="accent-color:var(--accent)" />
          Save for future runs (no typing next time)
        </label>
        <button id="tf-inline-submit" type="button"
          style="padding:8px;border-radius:8px;background:var(--accent);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
          Retry with login
        </button>
      </div>`;

    taskStepsEl.appendChild(li);

    const emailEl = document.getElementById("tf-inline-email") as HTMLInputElement;
    if (!emailEl.value) emailEl.focus();

    document.getElementById("tf-inline-submit")?.addEventListener("click", () => {
      const email = (document.getElementById("tf-inline-email") as HTMLInputElement).value.trim();
      const password = (document.getElementById("tf-inline-password") as HTMLInputElement).value.trim();
      const shouldSave = (document.getElementById("tf-inline-save") as HTMLInputElement).checked;
      if (shouldSave && email) {
        const task = tfCurrentTask ?? "";
        const isMsForm = /forms\.office\.com|forms\.microsoft\.com/i.test(extractUrl(task));
        const isLinkedIn = /linkedin/i.test(task);
        const isSwiggy = /swiggy/i.test(task);
        const isZomato = /zomato/i.test(task);
        chrome.storage.local.get([SITE_CREDS_STORAGE_KEY], (r) => {
          const existing = (r[SITE_CREDS_STORAGE_KEY] as Record<string, string>) ?? {};
          const updated = isMsForm
            ? { ...existing, microsoftEmail: email, microsoftPassword: password }
            : isLinkedIn
            ? { ...existing, linkedinEmail: email, linkedinPassword: password }
            : isSwiggy
            ? { ...existing, swiggyEmail: email, swiggyPassword: password }
            : isZomato
            ? { ...existing, zomatoEmail: email, zomatoPassword: password }
            : { ...existing, gmailEmail: email, gmailPassword: password };
          chrome.storage.local.set({ [SITE_CREDS_STORAGE_KEY]: updated });
        });
      }
      removeInlineLoginPrompt();
      stopTfPoll();
      finishRun();
      void startTinyFishRun(tfCurrentTask ?? "", email, password);
    });
  }

  function removeInlineLoginPrompt(): void {
    document.getElementById("tf-inline-login")?.remove();
  }

  async function pollTfStatus(
    runId: string,
    apiBase: string,
    seenLogs: Set<string>,
  ): Promise<void> {
    if (tfCurrentRunId !== runId) return;

    let status: string;
    let streamingUrl: string | undefined;
    let logs: string[] = [];
    let resultUrl: string | undefined;
    let error: string | undefined;

    try {
      const r = await fetch(`${apiBase}/api/tinyfish/${runId}/status`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = (await r.json()) as {
        status: string;
        streamingUrl?: string;
        logs?: string[];
        resultUrl?: string;
        error?: string;
        result?: Record<string, unknown> | null;
      };
      status = data.status;
      streamingUrl = data.streamingUrl;
      logs = data.logs ?? [];
      resultUrl = data.resultUrl;
      error = data.error;
      // Append TinyFish's own result summary to logs so login signals in it get detected
      if (data.result) {
        const summary = String(data.result.summary ?? data.result.message ?? data.result.output ?? "");
        if (summary && !seenLogs.has(`result:${summary}`)) {
          logs = [...logs, summary];
        }
      }
    } catch {
      if (tfCurrentRunId === runId) {
        tfPollTimer = setTimeout(() => void pollTfStatus(runId, apiBase, seenLogs), 3000);
      }
      return;
    }

    if (streamingUrl && tfLiveIframe.src !== streamingUrl) {
      tfLiveIframe.src = streamingUrl;
      tfCurrentStreamingUrl = streamingUrl;
      tfLivePlaceholder.classList.add("hidden");
      tfLiveIframe.classList.remove("hidden");
      tfBtnFullview.classList.remove("hidden");
      // Auto-open full view in a new tab immediately
      chrome.runtime.sendMessage({ type: "TINYFISH_OPEN_URL", url: streamingUrl });
    }

    const loginPattern = /log\s*in|sign\s*in|login|password|credential|authenticat|not logged|need to log|sign up|create account/i;
    const captchaPattern = /captcha|recaptcha|robot|verify you|human|crosswalk|traffic light|challenge|security check|bot detection|i am not a robot/i;

    let loginDetected = false;
    let captchaDetected = false;

    for (const line of logs) {
      if (!seenLogs.has(line)) {
        seenLogs.add(line);
        appendTfLog(line);
        if (loginPattern.test(line)) loginDetected = true;
        if (captchaPattern.test(line)) captchaDetected = true;
      }
    }

    // CAPTCHA detected — show countdown banner so user can solve it in the full view tab
    if (captchaDetected && !document.getElementById("tf-captcha-banner")) {
      showCaptchaBanner();
    }

    // When login detected mid-run — show inline prompt immediately
    if (loginDetected && !document.getElementById("tf-inline-login")) {
      showInlineLoginPrompt();
    }

    if (status === "completed" || status === "failed") {
      stopTfPoll();
      removeInlineLoginPrompt();
      removeCaptchaBanner();

      const allLogs = [...seenLogs].join(" ").toLowerCase();
      const hasCaptchaSignal = captchaPattern.test(allLogs);

      // CAPTCHA ended the session — show retry card with countdown
      if (hasCaptchaSignal && !resultUrl) {
        showCaptchaRetryCard();
        finishRun();
        return;
      }

      // Explicit BLOCKED by the target site (e.g. Microsoft Forms bot detection)
      const isBlocked = /blocked/i.test(error ?? "") || /blocked/i.test(allLogs);
      if (isBlocked && status === "failed") {
        tfLiveDot.classList.add("stopped");
        tfLiveStatusText.textContent = "Blocked by website";
        const isMsForm = /forms\.office\.com|forms\.microsoft\.com/i.test(tfCurrentTask ?? "");
        const hint = isMsForm
          ? "Microsoft Forms blocked TinyFish's cloud browser. Try: 1) Save your Microsoft account email/password in Settings → Site credentials, then retry. 2) Or open the form yourself and fill it manually — your profile data is saved in Settings."
          : "The website blocked TinyFish's cloud browser (bot detection). Try opening the link manually in a new tab and filling from Settings → Application Profile.";
        renderTaskSteps([{ text: hint, state: "error" }]);
        addLog(`⚠ Blocked by website: ${hint}`);
        finishRun();
        return;
      }

      // Treat as "needs login" when:
      // - explicitly failed/completed with login signals in logs
      // - OR completed with no meaningful result (no URL or only got a generic homepage)
      const isGenericUrl = (u?: string) =>
        !u || /^https?:\/\/(mail\.google\.com|www\.linkedin\.com|linkedin\.com|www\.google\.com|google\.com)\/?$/i.test(u);
      const hasLoginSignal = loginPattern.test(allLogs);
      const taskNotDone = isGenericUrl(resultUrl) && logs.length <= 6;
      const needsLogin = (status === "failed" && hasLoginSignal) ||
                         (status === "completed" && (hasLoginSignal || taskNotDone));

      if (needsLogin) {
        tfLiveDot.classList.add("stopped");
        tfLiveStatusText.textContent = "Login required — enter credentials & retry";
        renderTaskSteps([
          { text: "TinyFish couldn't log in. Enter your credentials below to retry.", state: "error" },
        ]);
        showInlineLoginPrompt();
        finishRun();
        return;
      }

      showTfResult(status as "completed" | "failed", resultUrl, error);
      finishRun();
      return;
    }

    tfPollTimer = setTimeout(() => void pollTfStatus(runId, apiBase, seenLogs), 2000);
  }

  async function startTinyFishRun(task: string, email = "", password = "", captchaRetry = false): Promise<void> {
    const stored = await chrome.storage.local.get([
      BYOK_TINYFISH_STORAGE_KEY,
      SITE_CREDS_STORAGE_KEY,
      APPLICATION_PROFILE_STORAGE_KEY,
      RESUME_STORAGE_KEY,
      RESUME_TEXT_STORAGE_KEY,
    ]);
    const tfKey =
      typeof stored[BYOK_TINYFISH_STORAGE_KEY] === "string"
        ? (stored[BYOK_TINYFISH_STORAGE_KEY] as string).trim()
        : "";

    // Auto-fill credentials from saved site creds if not explicitly provided
    if (!email) {
      const creds = stored[SITE_CREDS_STORAGE_KEY] as Record<string, string> | undefined;
      if (creds) {
        const detectedFormUrl = extractUrl(task);
        const isMsForm = /forms\.office\.com|forms\.microsoft\.com/i.test(detectedFormUrl);
        const isLinkedIn = /linkedin/i.test(task);
        const isSwiggy = /swiggy/i.test(task);
        const isZomato = /zomato/i.test(task);
        if (isMsForm) {
          email = creds.microsoftEmail ?? "";
          password = creds.microsoftPassword ?? "";
        } else if (isLinkedIn) {
          email = creds.linkedinEmail ?? "";
          password = creds.linkedinPassword ?? "";
        } else if (isSwiggy) {
          email = creds.swiggyEmail ?? "";
          password = creds.swiggyPassword ?? "";
        } else if (isZomato) {
          email = creds.zomatoEmail ?? "";
          password = creds.zomatoPassword ?? "";
        } else {
          email = creds.gmailEmail ?? "";
          password = creds.gmailPassword ?? "";
        }
      }
    }

    // Build profile hint from settings fields + stored resume text
    const profileRaw = stored[APPLICATION_PROFILE_STORAGE_KEY] as Record<string, string> | undefined;
    const resumeRaw = stored[RESUME_STORAGE_KEY] as { name?: string; mime?: string; base64?: string } | undefined;
    let resumeText = (stored[RESUME_TEXT_STORAGE_KEY] as string | undefined) ?? "";
    const hasResume = Boolean(resumeRaw?.name);

    // If resume text is empty but file exists, try re-extracting now (backend may not have been
    // running when the file was uploaded)
    if (!resumeText && resumeRaw?.base64) {
      try {
        const sync2 = await chrome.storage.sync.get(["apiBaseUrl"]);
        const b2 = typeof sync2.apiBaseUrl === "string" ? sync2.apiBaseUrl.trim() : "";
        const ab2 = b2 ? b2.replace(/\/$/, "") : "http://127.0.0.1:8080";
        const er = await fetch(`${ab2}/api/resume/extract`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64: resumeRaw.base64, mime: resumeRaw.mime ?? "application/pdf" }),
        });
        if (er.ok) {
          const erd = (await er.json()) as { text?: string };
          resumeText = (erd.text ?? "").trim();
          if (resumeText) {
            chrome.storage.local.set({ [RESUME_TEXT_STORAGE_KEY]: resumeText });
            addLog(`Resume text extracted on-demand: "${resumeText.slice(0, 60).replace(/\s+/g, " ")}…"`);
          }
        }
      } catch { /* backend not reachable — continue without */ }
    }

    let profileHint = "";
    if (profileRaw) {
      const fullName = profileRaw.fullName || `${profileRaw.firstName ?? ""} ${profileRaw.lastName ?? ""}`.trim();
      const location = [
        profileRaw.streetAddress,
        profileRaw.city,
        profileRaw.state,
        profileRaw.zipCode,
        profileRaw.country,
      ].filter(Boolean).join(", ");

      // Use slash-separated aliases so TinyFish matches any label variation in the form
      const labeled: [string, string][] = [
        ["Full name / Name", fullName],
        ["First name", profileRaw.firstName ?? ""],
        ["Last name / Surname", profileRaw.lastName ?? ""],
        ["Email / Email ID / Email address", profileRaw.email ?? ""],
        ["Phone / Contact number / Mobile / Cell", profileRaw.phone ?? ""],
        ["Address / Street", location],
        ["City", profileRaw.city ?? ""],
        ["State", profileRaw.state ?? ""],
        ["ZIP / Pincode / Postal code", profileRaw.zipCode ?? ""],
        ["Country", profileRaw.country ?? ""],
        ["LinkedIn", profileRaw.linkedInUrl ?? ""],
        ["Website / Portfolio", profileRaw.portfolioUrl ?? ""],
        ["Job title / Designation", profileRaw.currentJobTitle ?? ""],
        ["Employer / Company / Organisation", profileRaw.currentEmployer ?? ""],
      ];
      profileHint = labeled
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    }

    // Append raw resume text as a separate block — lets TinyFish fill education/custom fields
    if (resumeText) {
      const resumeBlock = `\n--- FULL RESUME TEXT (use to fill education, skills, or any other fields) ---\n${resumeText.slice(0, 2000)}`;
      profileHint = `${profileHint}\n${resumeBlock}`;
    }

    if (profileHint.trim()) {
      addLog(`Profile sent to TinyFish:\n${profileHint.slice(0, 300)}`);
    } else {
      addLog("⚠ No profile data — TinyFish may use placeholder values. Fill Settings → Application profile and fields auto-save.");
    }
    profileHint = profileHint.slice(0, 4000);

    const sync = await chrome.storage.sync.get(["apiBaseUrl"]);
    const raw = typeof sync.apiBaseUrl === "string" ? sync.apiBaseUrl.trim() : "";
    const apiBase = raw ? raw.replace(/\/$/, "") : "http://127.0.0.1:8080";

    tfCurrentTask = task;
    running = true;
    btnSend.disabled = true;
    taskCard.classList.remove("idle");
    const title = task.length > 76 ? `${task.slice(0, 76)}…` : task;
    setTaskTitle(title);
    renderTaskSteps([
      { text: "Starting TinyFish cloud browser…", state: "loading" },
    ]);
    showTfLiveSection();

    let runId: string;
    try {
      const resp = await fetch(`${apiBase}/api/tinyfish/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          email,
          password,
          apiKey: tfKey || undefined,
          profile: profileHint || undefined,
          hasResume,
          captchaRetry,
          formUrl: extractUrl(task) || undefined,
        }),
      });
      if (!resp.ok) {
        const err = (await resp.json().catch(() => ({ error: resp.statusText }))) as { error?: string };
        throw new Error(err.error ?? resp.statusText);
      }
      const data = (await resp.json()) as { runId: string };
      runId = data.runId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      renderTaskSteps([{ text: `TinyFish start failed: ${msg}`, state: "error" }]);
      tfLiveSection.classList.add("hidden");
      finishRun();
      addLog(`TinyFish error: ${msg}`);
      return;
    }

    tfCurrentRunId = runId;
    const isLinkedIn = /linkedin/i.test(task);
    const isSwiggy = /swiggy/i.test(task);
    const isZomato = /zomato/i.test(task);
    const detectedUrl = extractUrl(task);
    const stepText = isLinkedIn
      ? `TinyFish is searching LinkedIn and applying${hasResume ? " (resume attached)" : ""} — live view below.`
      : isSwiggy
      ? "TinyFish is placing your order on Swiggy — live view below."
      : isZomato
      ? "TinyFish is placing your order on Zomato — live view below."
      : detectedUrl
      ? `TinyFish is filling the form at ${detectedUrl} using your profile — live view below.`
      : "TinyFish is running in cloud — see live view below.";
    renderTaskSteps([{ text: stepText, state: "loading" }]);
    addLog(`TinyFish run started: ${runId}`);
    void pollTfStatus(runId, apiBase, new Set<string>());
  }

  // ─────────────────────────────────────────────────────────────────────────

  async function runTask(task: string): Promise<void> {
    const t = task.trim();
    if (!t || running) return;

    if (isTinyFishTask(t)) {
      void startTinyFishRun(t);
      return;
    }

    running = true;
    btnSend.disabled = true;
    taskCard.classList.remove("idle");

    const title = t.length > 76 ? `${t.slice(0, 76)}…` : t;
    setTaskTitle(title);

    const steps: Step[] = [{ text: "Prepared your request.", state: "done" }];

    if (shouldShowJobAssistPreamble(t)) {
      steps.push({ text: "Assistant is thinking…", state: "loading" });
      renderTaskSteps(steps);
      const assist = await fetchJobAssistPreamble(t);
      if (assist) {
        steps[steps.length - 1] = { text: assist, state: "done" };
      } else {
        steps.pop();
      }
    }

    steps.push({ text: "Sending to the active browser tab…", state: "loading" });
    renderTaskSteps(steps);

    // Side panel focus makes `currentWindow` unreliable; lastFocusedWindow matches the user’s browser window.
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tabs[0]?.id;

    if (tabId === undefined) {
      steps[1] = { text: "Could not find the active tab in this window. Click the page you want, then try again.", state: "error" };
      renderTaskSteps(steps);
      addLog("Error: no active tab");
      finishRun();
      return;
    }

    chrome.runtime.sendMessage(
      { type: "RUN_TASK_FROM_POPUP", task: t, tabId },
      (res: { ok?: boolean; error?: string; result?: string } | undefined) => {
        steps[1] = { text: "Message delivered to the tab.", state: "done" };
        const lastErr = chrome.runtime.lastError?.message;
        if (lastErr) {
          steps.push({ text: lastErr, state: "error" });
          addLog(`Error: ${lastErr}`);
        } else if (!res?.ok) {
          const msg = res?.error ?? "Task failed.";
          steps.push({ text: msg, state: "error" });
          addLog(`Failed: ${msg}`);
        } else {
          const msg = res?.result ?? "Done.";
          steps.push({ text: msg, state: "done" });
          addLog(`OK: ${msg.slice(0, 200)}${msg.length > 200 ? "…" : ""}`);
        }
        renderTaskSteps(steps);
        finishRun();
      },
    );
  }

  function runFromChat(): void {
    const t = chatInput.value.trim();
    if (!t) return;
    chatInput.value = "";
    void runTask(t);
  }

  /** Extract plain text from a resume file (PDF or text). Works on most unencrypted PDFs. */
  async function extractResumeText(file: File): Promise<string> {
    if (file.type === "text/plain") {
      return new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve((r.result as string) ?? "");
        r.readAsText(file);
      });
    }

    // PDF extraction — read as binary, pull text from BT...ET blocks
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Decode as latin-1 so byte values are preserved
    let raw = "";
    for (let i = 0; i < Math.min(bytes.length, 400_000); i++) {
      raw += String.fromCharCode(bytes[i]);
    }

    const texts: string[] = [];
    const btEt = /BT([\s\S]*?)ET/g;
    let m: RegExpExecArray | null;
    while ((m = btEt.exec(raw)) !== null) {
      const block = m[1];
      // Extract parenthetical strings: (Hello World)
      const parens = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let p: RegExpExecArray | null;
      while ((p = parens.exec(block)) !== null) {
        const txt = p[1]
          .replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ")
          .replace(/\\\\/g, "\\").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
        if (txt.trim().length > 1) texts.push(txt.trim());
      }
    }

    // Fallback: grab readable ASCII strings if BT/ET found nothing
    if (texts.length === 0) {
      const ascii = raw.match(/[\x20-\x7E]{4,}/g) ?? [];
      return ascii.join(" ").replace(/\s+/g, " ").slice(0, 3000);
    }

    return texts.join(" ").replace(/\s+/g, " ").slice(0, 3000);
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = reader.result as string;
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  btnSend.addEventListener("click", () => runFromChat());

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runFromChat();
    }
  });

  btnMenu.addEventListener("click", () => {
    if (drawerMenu.classList.contains("open")) closeDrawers();
    else openMenu();
  });

  btnLogs.addEventListener("click", () => {
    if (drawerLogs.classList.contains("open")) closeDrawers();
    else openLogsPanel();
  });

  backdrop.addEventListener("click", () => closeDrawers());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawers();
  });

  autofillFromResumeBtn.addEventListener("click", () => {
    chrome.storage.local.get([RESUME_TEXT_STORAGE_KEY, RESUME_STORAGE_KEY, APPLICATION_PROFILE_STORAGE_KEY], async (r) => {
      let text = (r[RESUME_TEXT_STORAGE_KEY] as string | undefined) ?? "";

      // If text not yet extracted, try extracting now
      if (!text) {
        const raw = r[RESUME_STORAGE_KEY] as { base64?: string; mime?: string } | undefined;
        if (!raw?.base64) {
          autofillStatus.textContent = "⚠ No resume uploaded yet. Use the paperclip button to attach your PDF.";
          return;
        }
        autofillStatus.textContent = "Extracting resume…";
        autofillFromResumeBtn.disabled = true;
        autofillStatus.textContent = "Extracting text from PDF…";
        try {
          const sync2 = await chrome.storage.sync.get(["apiBaseUrl"]);
          const b2 = typeof sync2.apiBaseUrl === "string" ? sync2.apiBaseUrl.trim() : "";
          const ab2 = b2 ? b2.replace(/\/$/, "") : "http://127.0.0.1:8080";
          const er = await fetch(`${ab2}/api/resume/extract`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base64: raw.base64, mime: raw.mime ?? "application/pdf" }),
          });
          const erd = await er.json() as { text?: string; error?: string };
          if (er.ok && erd.text) {
            text = erd.text.trim();
            chrome.storage.local.set({ [RESUME_TEXT_STORAGE_KEY]: text });
          } else {
            const errMsg = erd.error ?? (er.ok ? "empty text returned" : `HTTP ${er.status}`);
            autofillStatus.textContent = `⚠ Extraction error: ${errMsg}`;
            autofillFromResumeBtn.disabled = false;
            return;
          }
        } catch (fetchErr) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          autofillStatus.textContent = `⚠ Cannot reach backend: ${msg}. Is it running on port 8080?`;
          autofillFromResumeBtn.disabled = false;
          return;
        }
        autofillFromResumeBtn.disabled = false;
      }

      if (!text) {
        autofillStatus.textContent = "⚠ Resume text is empty after extraction. Try re-uploading your PDF.";
        return;
      }

      const parsed = parseResumeText(text);
      // Merge with existing profile (don't overwrite fields that are already filled)
      const existing = (r[APPLICATION_PROFILE_STORAGE_KEY] as Partial<ApplicationProfile>) ?? {};
      const merged: ApplicationProfile = { ...defaultApplicationProfile(), ...existing };
      for (const [key, val] of Object.entries(parsed) as [keyof ApplicationProfile, string][]) {
        if (!merged[key] && val) (merged as Record<string, string>)[key] = val;
      }

      writeProfileToDom(merged);
      chrome.storage.local.set({ [APPLICATION_PROFILE_STORAGE_KEY]: merged });

      const filled = Object.entries(parsed).filter(([, v]) => v).map(([k]) => k).join(", ");
      autofillStatus.textContent = filled
        ? `✓ Auto-filled: ${filled}. Review and save.`
        : "⚠ Could not extract structured fields — try filling manually.";
      addLog(`Profile auto-filled from resume: ${filled || "no fields detected"}`);
    });
  });

  saveProfileBtn.addEventListener("click", () => {
    const profile = readProfileFromDom();
    if (!profile.email.trim() && !profile.fullName.trim() && !profile.firstName.trim()) {
      addLog("Profile not saved: add at least email or name.");
      return;
    }
    chrome.storage.local.set({ [APPLICATION_PROFILE_STORAGE_KEY]: profile }, () => {
      const err = chrome.runtime.lastError?.message;
      if (err) addLog(`Profile save error: ${err}`);
      else addLog("Application profile saved.");
    });
  });

  saveByokBtn.addEventListener("click", () => {
    const openrouter = byokOpenrouterInput.value.trim();
    const openrouterModel = byokOpenrouterModelInput.value.trim();
    const groq = byokGroqInput.value.trim();
    const tinyfish = byokTinyfishInput.value.trim();
    chrome.storage.local.set(
      {
        [BYOK_OPENROUTER_STORAGE_KEY]: openrouter,
        [BYOK_OPENROUTER_MODEL_KEY]: openrouterModel,
        [BYOK_GROQ_STORAGE_KEY]: groq,
        [BYOK_TINYFISH_STORAGE_KEY]: tinyfish,
      },
      () => {
        const err = chrome.runtime.lastError?.message;
        if (err) {
          addLog(`BYOK save error: ${err}`);
          return;
        }
        chrome.storage.local.remove(BYOK_STORAGE_KEY, () => {
          refreshByokLlmStatus(openrouter, groq, "");
          if (openrouter || groq || tinyfish) {
            if (openrouter) {
              addLog("API keys saved. Gmail compose & formalize use OpenRouter.");
            } else {
              addLog("API keys saved. Gmail compose & formalize use Groq.");
            }
          } else {
            addLog("API keys cleared.");
          }
        });
      },
    );
  });

  saveSiteCredsBtn.addEventListener("click", () => {
    const creds = {
      microsoftEmail: savedMicrosoftEmail.value.trim(),
      microsoftPassword: savedMicrosoftPassword.value.trim(),
      gmailEmail: savedGmailEmail.value.trim(),
      gmailPassword: savedGmailPassword.value.trim(),
      linkedinEmail: savedLinkedinEmail.value.trim(),
      linkedinPassword: savedLinkedinPassword.value.trim(),
      swiggyEmail: savedSwiggyEmail.value.trim(),
      swiggyPassword: savedSwiggyPassword.value.trim(),
      zomatoEmail: savedZomatoEmail.value.trim(),
      zomatoPassword: savedZomatoPassword.value.trim(),
    };
    chrome.storage.local.set({ [SITE_CREDS_STORAGE_KEY]: creds }, () => {
      const hasAny = creds.microsoftEmail || creds.gmailEmail || creds.linkedinEmail || creds.swiggyEmail || creds.zomatoEmail;
      siteCredsStatus.textContent = hasAny
        ? "Saved! TinyFish will log in automatically — no typing needed."
        : "Credentials cleared.";
      addLog(hasAny ? "Site credentials saved for TinyFish auto-login." : "Site credentials cleared.");
    });
  });

  clearLogsBtn.addEventListener("click", () => {
    chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: [] }, () => renderLogList());
  });

  btnAttach.addEventListener("click", () => fileResume.click());

  fileResume.addEventListener("change", () => {
    const file = fileResume.files?.[0];
    fileResume.value = "";
    if (!file) return;
    if (file.size > MAX_RESUME_BYTES) {
      addLog(`Resume too large (max ~${Math.round(MAX_RESUME_BYTES / 1e6)}MB).`);
      return;
    }

    // Show loading state — badge won't say "ready" until extraction completes
    autofillStatus.innerHTML = `<span class="spinner"></span> Reading PDF…`;

    void (async () => {
      try {
        const base64 = await fileToBase64(file);
        const mime = file.type || "application/pdf";

        // Save raw file to storage but show "loading" badge (not ready yet)
        chrome.storage.local.set({ [RESUME_STORAGE_KEY]: { name: file.name, mime, base64 } }, () => {
          refreshResumeBadge("loading");
        });

        autofillStatus.innerHTML = `<span class="spinner"></span> Extracting text from <strong>${file.name}</strong>…`;
        addLog(`Resume attached: ${file.name} — extracting text via backend…`);

        // Extract text via backend
        const sync = await chrome.storage.sync.get(["apiBaseUrl"]);
        const rawBase = typeof sync.apiBaseUrl === "string" ? sync.apiBaseUrl.trim() : "";
        const apiBase = rawBase ? rawBase.replace(/\/$/, "") : "http://127.0.0.1:8080";

        let resp: Response;
        try {
          resp = await fetch(`${apiBase}/api/resume/extract`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base64, mime }),
          });
        } catch {
          refreshResumeBadge("error");
          autofillStatus.textContent = "⚠ Backend not running — start it on port 8080, then click ↺ Retry on the badge.";
          addLog("Resume saved but backend is not running. Start it on port 8080, then click ↺ Retry.");
          return;
        }

        const data = resp.ok
          ? (await resp.json() as { text?: string; error?: string })
          : { error: `HTTP ${resp.status}` };
        const resumeText = (data.text ?? "").trim();

        if (data.error || !resumeText) {
          refreshResumeBadge("error");
          autofillStatus.textContent = `⚠ ${data.error ?? "No text found in PDF"} — click ↺ Retry on the badge.`;
          addLog(`Resume extraction failed: ${data.error ?? "empty text"}. Click ↺ Retry next to the badge.`);
          return;
        }

        // Extraction success — save text and auto-populate profile fields
        chrome.storage.local.set({ [RESUME_TEXT_STORAGE_KEY]: resumeText }, () => {
          const parsed = parseResumeText(resumeText);
          chrome.storage.local.get([APPLICATION_PROFILE_STORAGE_KEY], (r2) => {
            const existing = (r2[APPLICATION_PROFILE_STORAGE_KEY] as Partial<ApplicationProfile>) ?? {};
            const merged: ApplicationProfile = { ...defaultApplicationProfile(), ...existing };
            for (const [key, val] of Object.entries(parsed) as [keyof ApplicationProfile, string][]) {
              if (!merged[key] && val) (merged as Record<string, string>)[key] = val;
            }
            chrome.storage.local.set({ [APPLICATION_PROFILE_STORAGE_KEY]: merged }, () => {
              writeProfileToDom(merged);
              refreshResumeBadge("ready");  // ← badge turns green only now
              const filled = Object.entries(parsed).filter(([, v]) => v).map(([k]) => k).join(", ");
              const msg = filled
                ? `✓ Resume ready — auto-filled: ${filled}`
                : `✓ Resume ready. Check Settings → Application Profile to review.`;
              autofillStatus.textContent = msg;
              addLog(msg);
            });
          });
        });
      } catch {
        refreshResumeBadge("error");
        autofillStatus.textContent = "⚠ Could not read file.";
        addLog("Could not read resume file.");
      }
    })();
  });

  btnGlobe.addEventListener("click", () => {
    chatBox.animate(
      [
        { boxShadow: "0 0 0 1px rgba(124,58,237,0.5)" },
        { boxShadow: "0 0 0 1px rgba(124,58,237,0)" },
      ],
      { duration: 600 },
    );
  });

  tfBtnFullview.addEventListener("click", () => {
    if (tfCurrentStreamingUrl) {
      chrome.runtime.sendMessage({ type: "TINYFISH_OPEN_URL", url: tfCurrentStreamingUrl });
    }
  });

  tfBtnStop.addEventListener("click", () => {
    stopTfPoll();
    removeInlineLoginPrompt();
    removeCaptchaBanner();
    tfLiveDot.classList.add("stopped");
    tfLiveStatusText.textContent = "Stopped";
    renderTaskSteps([{ text: "TinyFish run stopped by user.", state: "error" }]);
    addLog("TinyFish run stopped.");
    finishRun();
  });

  tfBtnCredsToggle.addEventListener("click", () => {
    tfCredStrip.classList.toggle("hidden");
    if (!tfCredStrip.classList.contains("hidden")) tfCredEmail.focus();
  });

  tfCredRetry.addEventListener("click", () => {
    const task = tfCurrentTask;
    if (!task) return;
    const email = tfCredEmail.value.trim();
    const password = tfCredPassword.value.trim();
    stopTfPoll();
    finishRun();
    void startTinyFishRun(task, email, password);
  });

  document.querySelectorAll<HTMLButtonElement>(".preset-card").forEach((card) => {
    card.addEventListener("click", () => {
      const preset = card.dataset.preset;
      if (preset) void runTask(preset);
    });
  });

  pillFill.addEventListener("click", () => {
    chatInput.value = "";
    chatInput.placeholder = "Paste form URL here… (Google Forms, Typeform, Workday, Greenhouse…)";
    chatInput.focus();
    setTimeout(() => { chatInput.placeholder = "Ask anything or paste a form URL…"; }, 8000);
  });

  pillCompose.addEventListener("click", () => {
    chatInput.value = "compose a mail to ";
    chatInput.focus();
  });

  pillFormalize.addEventListener("click", () => void runTask("Make this email formal and professional."));

  pillSwiggy.addEventListener("click", () => {
    chatInput.value = "order food on swiggy — ";
    chatInput.focus();
  });

  pillZomato.addEventListener("click", () => {
    chatInput.value = "order food on zomato — ";
    chatInput.focus();
  });

  brandLogo.addEventListener(
    "error",
    () => {
      brandLogo.style.visibility = "hidden";
      if (brandLogo.parentElement?.querySelector(".brand-fallback")) return;
      const fallback = document.createElement("span");
      fallback.className = "brand-fallback";
      fallback.textContent = "NEXUS";
      fallback.style.fontWeight = "800";
      fallback.style.fontSize = "15px";
      fallback.style.letterSpacing = "0.08em";
      brandLogo.parentElement?.appendChild(fallback);
    },
    { once: true },
  );

  loadProfile();
  loadByok();
  loadSiteCreds();
  refreshResumeBadge();

  // Auto-save profile on every field change — no need to click "Save" manually
  for (const [, id] of FIELD_IDS) {
    document.getElementById(id)?.addEventListener("input", scheduleProfileAutoSave);
  }
}
