import {
  ACTIVITY_LOG_KEY,
  APPLICATION_PROFILE_STORAGE_KEY,
  BYOK_GROQ_STORAGE_KEY,
  BYOK_STORAGE_KEY,
  BYOK_TINYFISH_STORAGE_KEY,
  RESUME_STORAGE_KEY,
  defaultApplicationProfile,
  type ApplicationProfile,
} from "../application-profile";

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
  const saveByokBtn = document.getElementById("save-byok") as HTMLButtonElement;
  const byokGroqInput = document.getElementById("byok-groq") as HTMLInputElement;
  const byokTinyfishInput = document.getElementById("byok-tinyfish") as HTMLInputElement;
  const pillFill = document.getElementById("pill-fill") as HTMLButtonElement;
  const pillCompose = document.getElementById("pill-compose") as HTMLButtonElement;
  const brandLogo = document.getElementById("brand-logo") as HTMLImageElement;
  const chatBox = document.querySelector(".chat-box") as HTMLElement;

  let running = false;

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

  function loadByok(): void {
    chrome.storage.local.get(
      [BYOK_GROQ_STORAGE_KEY, BYOK_TINYFISH_STORAGE_KEY, BYOK_STORAGE_KEY],
      (r) => {
        const groq = typeof r[BYOK_GROQ_STORAGE_KEY] === "string" ? r[BYOK_GROQ_STORAGE_KEY] : "";
        const legacy = typeof r[BYOK_STORAGE_KEY] === "string" ? r[BYOK_STORAGE_KEY] : "";
        const tinyfish =
          typeof r[BYOK_TINYFISH_STORAGE_KEY] === "string" ? r[BYOK_TINYFISH_STORAGE_KEY] : "";
        byokGroqInput.value = groq || legacy;
        byokTinyfishInput.value = tinyfish;
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

  function refreshResumeBadge(): void {
    chrome.storage.local.get([RESUME_STORAGE_KEY], (r) => {
      const x = r[RESUME_STORAGE_KEY] as { name?: string } | undefined;
      resumeStatus.textContent = x?.name ? `Resume: ${x.name}` : "";
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

  async function runTask(task: string): Promise<void> {
    const t = task.trim();
    if (!t || running) return;

    running = true;
    btnSend.disabled = true;
    taskCard.classList.remove("idle");

    const title = t.length > 76 ? `${t.slice(0, 76)}…` : t;
    setTaskTitle(title);

    const steps: Step[] = [
      { text: "Prepared your request.", state: "done" },
      { text: "Sending to the active browser tab…", state: "loading" },
    ];
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
    const groq = byokGroqInput.value.trim();
    const tinyfish = byokTinyfishInput.value.trim();
    chrome.storage.local.set(
      {
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
          if (groq || tinyfish) {
            addLog("Groq / TinyFish API keys saved locally.");
          } else {
            addLog("API keys cleared.");
          }
        });
      },
    );
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
    void (async () => {
      try {
        const base64 = await fileToBase64(file);
        chrome.storage.local.set(
          {
            [RESUME_STORAGE_KEY]: {
              name: file.name,
              mime: file.type || "application/pdf",
              base64,
            },
          },
          () => {
            refreshResumeBadge();
            addLog(`Resume attached: ${file.name}`);
          },
        );
      } catch {
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

  document.querySelectorAll<HTMLButtonElement>(".preset-card").forEach((card) => {
    card.addEventListener("click", () => {
      const preset = card.dataset.preset;
      if (preset) void runTask(preset);
    });
  });

  pillFill.addEventListener("click", () => void runTask("fill application form"));

  pillCompose.addEventListener("click", () => {
    chatInput.value = "compose a mail to ";
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
  refreshResumeBadge();
}
