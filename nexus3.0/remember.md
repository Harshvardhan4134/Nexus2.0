# Nexus 3.0 — project notes

## Live Browser: what it actually is

When you open a session and use the **Live Browser** tab in the Nexus UI:

- The backend runs **Playwright** with **Chromium** (`live-browser.ts`: `launchPersistentContext`).
- **Default:** `headless: true` — no OS window; you only see a **live stream of JPEG screenshots** (about every 500ms) over **SSE** (`GET /api/agent/sessions/:id/stream`) in the Nexus session page (`session.tsx`). The Vite dev server proxies `/api` to the API; the proxy is configured so **SSE / event-stream** is not buffered. **`vite preview`** uses the same proxy. If the live pane stays blank, set **`VITE_API_ORIGIN=http://127.0.0.1:8080`** in `.env` so EventSource hits the API directly (CORS is open on the API).
- **Headed vs headless:** With `NODE_ENV=development` (e.g. `pnpm run dev` in `api-server`), the API defaults to **headed** Chromium so you can sign in in a real window. Set **`NEXUS_HEADED_BROWSER=0`** to force headless in dev. In production, default is headless unless `NEXUS_HEADED_BROWSER=1` or `PLAYWRIGHT_HEADED=1`.

**Why automation cannot move “into” the React Live Browser panel:** The web UI is not a real browser engine. All scripted actions must target a real page via Playwright (or similar). The panel is a **mirror** (screenshots) plus optional user clicks forwarded to coordinates on that same Playwright page.

**Profiles path:** `path.join(os.tmpdir(), "nexus-browser-profiles")` (works on Windows and Unix). **Chromium binary:** uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if set and the file exists, else the Replit Nix path if present, else Playwright’s bundled Chromium.

### Use your installed Chrome as a new tab (CDP)

Playwright’s default session is **not** the same process as your everyday Chrome. To automate **inside the Chrome you already use** (one new tab, same logins):

1. **Quit Chrome completely**, then start it with remote debugging (Windows example — adjust profile path if you use a non-default user data dir):

   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222`

   Or duplicate your shortcut and add `--remote-debugging-port=9222` to **Target** (leave the rest of the command line as-is).

2. In `.env` (or the shell that starts the API), set:

   `PLAYWRIGHT_CDP_URL=http://127.0.0.1:9222`

   Use the **http** URL only — not a `ws://` DevTools WebSocket URL.

3. Restart the API. Nexus will **`connectOverCDP`**, open **one new tab** in that Chrome, and run tasks there. Ending the session closes that tab and disconnects; it does **not** quit your whole browser.

**Note:** Only one primary debugger per Chrome instance; close other tools that attach to the same port.

---

## Gmail auto-send & LinkedIn auto-apply (task runner)

**File:** `artifacts/api-server/src/services/task-runner.ts`

Existing intent parsing, `runEmail` / `runJob` structure, navigation, compose flow, and LinkedIn search / first job / Easy Apply click are **unchanged in behavior**; only the **post-compose** and **post–Easy Apply open** steps were extended.

### Gmail

- After filling To / Subject / Body, the runner **tries to click Gmail’s Send** using several CSS/tooltip selectors (`tryClickGmailSend`).
- If that fails (Gmail UI changed, CAPTCHA, etc.), it falls back to **`waitForUser`** so you can send manually and press Resume.

### LinkedIn Easy Apply

- After the Easy Apply modal opens, **`tryAdvanceLinkedInEasyApply`** loops (up to 25 steps) and tries to click **Next / Continue / Review / Submit application** via roles and class selectors (`tryClickLinkedInEasyApplyPrimary`).
- If it detects success text (e.g. “Application submitted”), it stops.
- If it cannot find a button, it **pauses** with `waitForUser` for manual completion.

**Caveats:** LinkedIn and Gmail UIs change often; auto actions may need selector updates. File uploads and unusual flows may still require manual steps.

### Environment variables (opt out of automation)

| Variable | Effect |
|----------|--------|
| `NEXUS_AUTO_SEND_EMAIL=0` | After compose, **do not** auto-click Send; use the old manual review + Resume flow. |
| `NEXUS_AUTO_LINKEDIN_APPLY=0` | After Easy Apply opens, **do not** auto-advance; use the old manual Resume flow. |

Default when unset: **auto-send** and **auto–Easy Apply** are **on**.

---

## Earlier setup (from prior work in this repo)

- **Package manager:** Monorepo uses **pnpm** only; root `preinstall` enforces pnpm (Node-based on Windows).
- **`pnpm-workspace.yaml`:** Windows optional native deps for Rollup / Tailwind / LightningCSS / esbuild were restored so Vite runs on Windows (Replit-oriented overrides had stripped win32 binaries).
- **`artifacts/api-server`:** `dev` uses **cross-env** for `NODE_ENV` on Windows.
- **Database:** `@workspace/db` uses **Firebase Admin + Firestore** (not PostgreSQL). Init supports emulator (`FIRESTORE_EMULATOR_HOST`), `FIREBASE_SERVICE_ACCOUNT_JSON`, or `GOOGLE_APPLICATION_CREDENTIALS`. API entry imports `@workspace/db` to initialize Firebase.
- **Firebase CLI:** Root `devDependency` **firebase-tools**; `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`; scripts `pnpm run firebase:emulators`, etc. Firestore emulator defaults to **127.0.0.1:8085** (API often on 8080). **Java** is required on the machine to run the Firestore emulator.

---

## Files touched for auto-send / auto-apply

- `artifacts/api-server/src/services/task-runner.ts` — helpers + env flags + end of `runEmail` / `runJob` (LinkedIn branch)
- `artifacts/api-server/src/services/live-browser.ts` — headed mode, temp profile dir, optional Chromium path
- `remember.md` — this file

---

## Chrome extension (`artifacts/nexus-extension`)

**Purpose:** Run Nexus-style tasks **in your real Chrome tab** using a **content script** (DOM clicks / typing), instead of the server’s Playwright session.

**Build:** From repo root: `pnpm --filter @workspace/nexus-extension run build` → output in `artifacts/nexus-extension/dist/`.

**Load in Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** → select the `dist` folder.

**How it works:**

- **Popup:** enter task text → **Run in this tab**.
- **Background** service worker may **navigate the active tab** to Gmail or LinkedIn when the task looks like email / job (same rough intent patterns as the server).
- **Content script** (`content.js`, matches `http://*/*` and `https://*/*`) receives `EXECUTE_TASK` and runs Gmail compose / LinkedIn job search + Easy Apply steps in-page.

**Limits vs the web app + Playwright:**

- No live screenshot SSE panel; you see the **real page** in Chrome.
- Selectors can break when Gmail/LinkedIn change UI.
- **LinkedIn job flow:** first run may only **open the job search URL**; **run the same task again** on the search results page to click a listing and advance Easy Apply (full auto across navigations would need more state machine / messaging).
- Broad `host_permissions` — tighten `manifest.json` before publishing to the Web Store.

**Package:** `@workspace/nexus-extension` (see `artifacts/nexus-extension/package.json`).

---

## Troubleshooting: “error” and empty logs

1. **API must start** — The UI loads session data from `/api/agent/sessions/:id`. If the API crashes on boot, you get “Session not found” or endless loading, and **no logs** (logs come from the live browser session on the server).

2. **Firebase was blocking startup** — The API no longer imports `@workspace/db` on boot, so missing Firebase credentials will not stop the server. If you add Firestore usage later, configure env vars or import `db` only where needed.

3. **`.env` location** — Put `PORT=8080` (optional; defaults to 8080), API keys, etc. in **`Nexus3,0/.env`** (workspace root above `nexus3.0/`) **or** `nexus3.0/.env`. The API loads both via `artifacts/api-server/src/env.ts`. The Vite app loads env from the same workspace root via `envDir` in `vite.config.ts`.

4. **Vite `PORT` / `BASE_PATH`** — If unset, they default to **5173** and **`/`** so the dev server can start without a `.env`.

5. **Empty logs in the session UI** — Logs and actions are filled only after **Playwright** launches (`liveBrowser`). If Chromium fails (missing Playwright browsers: run `pnpm exec playwright install`), or the task crashes before the browser session exists, the Logs tab stays empty. Check the **terminal** where `api-server` runs for pino output and stack traces.

6. **`waiting_for_user` + Resume** — The API sets `status: waiting_for_user` when the task calls `waitForUser` (e.g. Gmail login). The session page must show a **Resume** bar that `POST`s `/api/agent/sessions/:id/resume`. Earlier builds only handled `waiting_for_input` (chat), so the bottom bar was hidden and users felt stuck. Fixed in `artifacts/nexus-agent/src/pages/session.tsx`.
