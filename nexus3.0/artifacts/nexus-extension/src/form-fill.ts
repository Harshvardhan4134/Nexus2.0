/**
 * Heuristic autofill for ATS / Workday-style job applications.
 * Walks same-origin iframes; skips file inputs (upload UI comes later).
 */

import {
  APPLICATION_PROFILE_STORAGE_KEY,
  RESUME_STORAGE_KEY,
  defaultApplicationProfile,
  mergeDerivedNames,
  type ApplicationProfile,
} from "./application-profile";

export function loadApplicationProfile(): Promise<ApplicationProfile> {
  return new Promise((resolve) => {
    chrome.storage.local.get([APPLICATION_PROFILE_STORAGE_KEY], (r) => {
      const raw = r[APPLICATION_PROFILE_STORAGE_KEY];
      const base = defaultApplicationProfile();
      if (raw && typeof raw === "object") {
        Object.assign(base, raw as Partial<ApplicationProfile>);
      }
      resolve(mergeDerivedNames(base));
    });
  });
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeCssId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }
  return id.replace(/([^\w-])/g, "\\$1");
}

function collectFieldHint(el: Element): string {
  const parts: string[] = [];
  const h = el as HTMLElement;
  const add = (s: string | null | undefined) => {
    if (s) parts.push(s);
  };
  add(h.id);
  add(h.getAttribute("name"));
  add(h.getAttribute("placeholder"));
  add(h.getAttribute("aria-label"));
  add(h.getAttribute("data-automation-id"));
  add(h.getAttribute("data-test-id"));
  add(h.getAttribute("data-testid"));
  add(h.getAttribute("data-cy"));
  add(h.getAttribute("data-qa"));
  add(h.getAttribute("autocomplete"));
  add(h.getAttribute("title"));

  const labelledBy = h.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      add(ref?.textContent ?? undefined);
    }
  }
  const describedBy = h.getAttribute("aria-describedby");
  if (describedBy) {
    for (const id of describedBy.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      add(ref?.textContent ?? undefined);
    }
  }

  if (h.id) {
    const lb = el.ownerDocument.querySelector(`label[for="${escapeCssId(h.id)}"]`);
    add(lb?.textContent ?? undefined);
  }
  const wrapLabel = h.closest("label");
  if (wrapLabel) add(wrapLabel.textContent ?? undefined);

  let walk: Element | null = h.parentElement;
  for (let d = 0; d < 8 && walk; d++, walk = walk.parentElement) {
    add(walk.getAttribute("data-automation-id"));
    add(walk.getAttribute("data-test-id"));
    add(walk.getAttribute("data-testid"));
    add(walk.getAttribute("data-qa"));
    add(walk.getAttribute("aria-label"));
    add(walk.getAttribute("role"));
    if (walk.tagName === "FIELDSET") {
      const leg = walk.querySelector("legend");
      add(leg?.textContent ?? undefined);
    }
  }

  return norm(parts.join(" "));
}

type ProfileKey = keyof ApplicationProfile;

const FIELD_SPECS: { key: ProfileKey; keywords: string[]; weight: number }[] = [
  { key: "firstName", weight: 3, keywords: ["first name", "given name", "legal first", "firstname", "fname", "legalfirst", "first-name", "name--first"] },
  { key: "lastName", weight: 3, keywords: ["last name", "family name", "surname", "legal last", "lastname", "lname", "legallast", "last-name", "name--last"] },
  { key: "fullName", weight: 2, keywords: ["full name", "applicant name", "candidate name", "your name", "complete name", "name (as"] },
  {
    key: "email",
    weight: 3,
    keywords: ["email", "e-mail", "mail address", "contact email", "email address", "your e-mail"],
  },
  {
    key: "phone",
    weight: 3,
    keywords: [
      "phone",
      "mobile",
      "cell",
      "telephone",
      "tel",
      "phonenumber",
      "phone number",
      "contact number",
      "cell phone",
      "mobile number",
    ],
  },
  { key: "streetAddress", weight: 2, keywords: ["address line 1", "street address", "address 1", "mailing address", "home address", "street"] },
  { key: "city", weight: 2, keywords: ["city", "town", "locality"] },
  { key: "state", weight: 2, keywords: ["state", "province", "region", "county"] },
  { key: "zipCode", weight: 2, keywords: ["zip", "postal", "postcode", "post code"] },
  { key: "country", weight: 2, keywords: ["country", "nation"] },
  { key: "linkedInUrl", weight: 2, keywords: ["linkedin", "linked in", "linked-in"] },
  { key: "portfolioUrl", weight: 2, keywords: ["website", "portfolio", "personal site", "url", "github"] },
  { key: "currentEmployer", weight: 2, keywords: ["current employer", "employer", "company", "current company", "organization", "organisation"] },
  { key: "currentJobTitle", weight: 2, keywords: ["job title", "position title", "current title", "your title", "role"] },
];

function scoreHint(hint: string, keywords: string[], weight: number): number {
  let s = 0;
  for (const kw of keywords) {
    const k = norm(kw);
    if (k && hint.includes(k)) s += Math.min(8, 2 + Math.floor(k.length / 3));
  }
  return s * weight;
}

function profileKeyFromIdOrName(id: string, name: string): ProfileKey | null {
  const bag = norm(`${id} ${name}`);
  if (!bag) return null;
  if (/\b(e-?mail|emailaddr|mailaddress|contactemail|workemail)\b/.test(bag)) return "email";
  if (/\b(fname|first-?name|firstname|givenname|given-?name|first_name)\b/.test(bag)) return "firstName";
  if (/\b(lname|last-?name|lastname|surname|familyname|family-?name|last_name)\b/.test(bag)) return "lastName";
  if (/\b(full-?name|fullname|applicantname)\b/.test(bag)) return "fullName";
  if (/\b(phone|mobile|cell|telephone|tel|sms|contactnumber)\b/.test(bag)) return "phone";
  if (/\b(address1|addr1|street|mailingaddr|line1)\b/.test(bag)) return "streetAddress";
  if (/\b(city|town|locality)\b/.test(bag)) return "city";
  if (/\b(state|province|region|county)\b/.test(bag)) return "state";
  if (/\b(zip|postal|postcode|zipcode)\b/.test(bag)) return "zipCode";
  if (/\b(country|nation)\b/.test(bag)) return "country";
  if (/\b(linkedin|linked-in)\b/.test(bag)) return "linkedInUrl";
  if (/\b(website|portfolio|github|url)\b/.test(bag)) return "portfolioUrl";
  if (/\b(employer|company|organization|orgname)\b/.test(bag)) return "currentEmployer";
  if (/\b(jobtitle|positiontitle|currenttitle)\b/.test(bag)) return "currentJobTitle";
  return null;
}

function focusBeforeFill(el: HTMLElement): void {
  try {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      el.focus({ preventScroll: true });
    } else {
      el.focus({ preventScroll: true });
    }
  } catch {
    /* ignore */
  }
}

function bestSpecForHint(
  hint: string,
  opts?: { minScore?: number },
): { key: ProfileKey; score: number } | null {
  const minScore = opts?.minScore ?? 5;
  let best: { key: ProfileKey; score: number } | null = null;
  for (const spec of FIELD_SPECS) {
    const sc = scoreHint(hint, spec.keywords, spec.weight);
    if (sc >= minScore && (!best || sc > best.score)) {
      best = { key: spec.key, score: sc };
    }
  }

  const h = norm(hint);
  if (
    /\bwhat\s+is\s+your\s+name\b/.test(h) ||
    (/\byour\s+name\b/.test(h) && !/\bcompany|employer|organization|business\s+name\b/.test(h))
  ) {
    const sc = 14;
    if (!best || sc > best.score) best = { key: "fullName", score: sc };
  }
  if (/\byour\s+e[\s-]*mail\b/.test(h) || /\bemail\s+address\b/.test(h)) {
    const sc = 14;
    if (!best || sc > best.score) best = { key: "email", score: sc };
  }
  if (/\bphone\s+number\b/.test(h) || /\bcontact\s+number\b/.test(h) || /\bmobile\s+number\b/.test(h)) {
    const sc = 14;
    if (!best || sc > best.score) best = { key: "phone", score: sc };
  }

  return best && best.score >= minScore ? best : null;
}

function profileValue(profile: ApplicationProfile, key: ProfileKey): string {
  return String(profile[key] ?? "").trim();
}

function setReactFriendlyValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

type FormRoot = Document | ShadowRoot | HTMLElement;

/** Standard autocomplete tokens → profile keys (many forms have no visible labels). */
const AUTOCOMPLETE_TO_PROFILE: Partial<Record<string, ProfileKey>> = {
  "given-name": "firstName",
  "additional-name": "firstName",
  "family-name": "lastName",
  name: "fullName",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "tel-local": "phone",
  "street-address": "streetAddress",
  "address-line1": "streetAddress",
  "address-line2": "streetAddress",
  "address-level2": "city",
  "address-level1": "state",
  "postal-code": "zipCode",
  country: "country",
  "country-name": "country",
  organization: "currentEmployer",
  "organization-title": "currentJobTitle",
  url: "portfolioUrl",
  photo: "portfolioUrl",
};

function autocompleteProfileKey(raw: string | null | undefined): ProfileKey | null {
  if (!raw?.trim()) return null;
  const tokens = raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p && !/^section-/.test(p) && !/^(shipping|billing|home|work|fax|pager|im)$/i.test(p));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const k = AUTOCOMPLETE_TO_PROFILE[tokens[i]];
    if (k) return k;
  }
  return null;
}

function gatherShadowRootsDeep(root: FormRoot): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const walk = (r: FormRoot): void => {
    r.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    });
  };
  walk(root);
  return out;
}

function pushInputEvent(el: HTMLElement, data: string): void {
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const vn = norm(v);
  for (const op of Array.from(el.options)) {
    const ot = norm(op.text);
    const ov = norm(op.value);
    if (ot === vn || ov === vn || ot.includes(vn) || vn.includes(ot)) {
      el.value = op.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
  }
  return false;
}

function shouldSkipControl(el: HTMLElement): boolean {
  if (el.closest("[hidden], [aria-hidden='true']")) return true;
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  return false;
}

function fillFormInDocument(root: FormRoot, profile: ApplicationProfile): number {
  let filled = 0;
  const merged = mergeDerivedNames(profile);

  const nodes = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input, textarea, select",
  );

  for (const el of nodes) {
    if (shouldSkipControl(el)) continue;

    if (el instanceof HTMLSelectElement) {
      const hint = collectFieldHint(el);
      let best = bestSpecForHint(hint, { minScore: 6 });
      if (!best) {
        const pk = profileKeyFromIdOrName(el.id, el.getAttribute("name") ?? "");
        if (pk) best = { key: pk, score: 6 };
      }
      if (!best) continue;
      const val = profileValue(merged, best.key);
      if (!val) continue;
      if (el.value.trim().length > 1) continue;
      focusBeforeFill(el);
      if (fillSelect(el, val)) filled++;
      continue;
    }

    if (el instanceof HTMLTextAreaElement) {
      if (el.readOnly || el.disabled) continue;
      if (el.value.trim().length > 1) continue;
      const acKeyTa = autocompleteProfileKey(el.getAttribute("autocomplete"));
      if (acKeyTa) {
        let valAc = profileValue(merged, acKeyTa);
        if (acKeyTa === "portfolioUrl" && !valAc) valAc = profileValue(merged, "linkedInUrl");
        if (valAc) {
          focusBeforeFill(el);
          setReactFriendlyValue(el, valAc);
          filled++;
          continue;
        }
      }
      const hint = collectFieldHint(el);
      let best = bestSpecForHint(hint);
      if (!best) {
        const pk = profileKeyFromIdOrName(el.id, el.getAttribute("name") ?? "");
        if (pk) best = { key: pk, score: 5 };
      }
      if (!best) continue;
      let val = profileValue(merged, best.key);
      if (!val && best.key === "fullName") {
        val =
          profileValue(merged, "fullName") ||
          [merged.firstName, merged.lastName].filter(Boolean).join(" ");
      }
      if (!val) continue;
      focusBeforeFill(el);
      setReactFriendlyValue(el, val);
      filled++;
      continue;
    }

    const input = el;
    const type = (input.type || "text").toLowerCase();
    if (
      type === "hidden" ||
      type === "submit" ||
      type === "button" ||
      type === "image" ||
      type === "checkbox" ||
      type === "radio" ||
      type === "file" ||
      type === "range" ||
      type === "color" ||
      type === "date"
    ) {
      continue;
    }

    if (input.readOnly || input.disabled) continue;
    if (input.value.trim().length > 1) continue;

    const acKey = autocompleteProfileKey(input.getAttribute("autocomplete"));
    if (acKey) {
      let val = profileValue(merged, acKey);
      if (acKey === "portfolioUrl" && !val) val = profileValue(merged, "linkedInUrl");
      if (val) {
        focusBeforeFill(input);
        setReactFriendlyValue(input, val);
        filled++;
        continue;
      }
    }

    if (type === "email") {
      const em = profileValue(merged, "email");
      if (em) {
        focusBeforeFill(input);
        setReactFriendlyValue(input, em);
        filled++;
      }
      continue;
    }
    if (type === "url") {
      const li = profileValue(merged, "linkedInUrl");
      const po = profileValue(merged, "portfolioUrl");
      const u = li || po;
      if (u) {
        focusBeforeFill(input);
        setReactFriendlyValue(input, u);
        filled++;
      }
      continue;
    }
    if (type === "tel") {
      const ph = profileValue(merged, "phone");
      if (ph) {
        focusBeforeFill(input);
        setReactFriendlyValue(input, ph);
        filled++;
      }
      continue;
    }

    const hint = collectFieldHint(input);
    let best = bestSpecForHint(hint);
    if (!best) {
      const pk = profileKeyFromIdOrName(input.id, input.getAttribute("name") ?? "");
      if (pk) best = { key: pk, score: 5 };
    }
    if (!best) continue;

    let val = profileValue(merged, best.key);
    if (!val && best.key === "fullName") {
      val =
        profileValue(merged, "fullName") ||
        [merged.firstName, merged.lastName].filter(Boolean).join(" ");
    }
    if (!val) continue;

    focusBeforeFill(input);
    setReactFriendlyValue(input, val);
    filled++;
  }

  const editables = root.querySelectorAll<HTMLElement>('[contenteditable="true"]');
  for (const el of editables) {
    if (shouldSkipControl(el)) continue;
    if (el.querySelector(":scope > [contenteditable='true']")) continue;
    if ((el.textContent ?? "").trim().length > 2) continue;
    const hint = collectFieldHint(el);
    let best = bestSpecForHint(hint);
    if (!best) {
      const pk = profileKeyFromIdOrName(el.id, el.getAttribute("name") ?? "");
      if (pk) best = { key: pk, score: 5 };
    }
    if (!best) continue;
    let val = profileValue(merged, best.key);
    if (!val && best.key === "fullName") {
      val =
        profileValue(merged, "fullName") ||
        [merged.firstName, merged.lastName].filter(Boolean).join(" ");
    }
    if (!val) continue;
    focusBeforeFill(el);
    el.textContent = val;
    try {
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: val }),
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    filled++;
  }

  const ariaTextboxes = root.querySelectorAll<HTMLElement>(
    '[role="textbox"]:not(input):not(textarea)',
  );
  for (const el of ariaTextboxes) {
    if (shouldSkipControl(el)) continue;
    if (el.getAttribute("contenteditable") === "true") continue;
    const t = (el.textContent ?? "").trim();
    if (t.length > 2) continue;
    const hint = collectFieldHint(el);
    let best = bestSpecForHint(hint);
    if (!best) {
      const pk = profileKeyFromIdOrName(el.id, el.getAttribute("name") ?? "");
      if (pk) best = { key: pk, score: 5 };
    }
    if (!best) continue;
    let val = profileValue(merged, best.key);
    if (!val && best.key === "fullName") {
      val =
        profileValue(merged, "fullName") ||
        [merged.firstName, merged.lastName].filter(Boolean).join(" ");
    }
    if (!val) continue;
    focusBeforeFill(el);
    el.textContent = val;
    pushInputEvent(el, val);
    filled++;
  }

  return filled;
}

/** Same as fillFormInDocument plus open shadow roots (Easy Apply modal, ATS widgets). */
export function fillFormWithin(root: Document | ShadowRoot | HTMLElement, profile: ApplicationProfile): number {
  let n = fillFormInDocument(root, profile);
  for (const sr of gatherShadowRootsDeep(root)) {
    n += fillFormInDocument(sr, profile);
  }
  return n;
}

function fillTree(doc: Document, profile: ApplicationProfile): number {
  let n = fillFormInDocument(doc, profile);
  for (const sr of gatherShadowRootsDeep(doc)) {
    n += fillFormInDocument(sr, profile);
  }
  doc.querySelectorAll("iframe").forEach((fr) => {
    try {
      const d = fr.contentDocument;
      if (d?.body) n += fillTree(d, profile);
    } catch {
      /* cross-origin */
    }
  });
  return n;
}

function attachResumeInDocument(root: FormRoot, file: File): number {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(
    (h) => !h.disabled && !h.closest("[hidden]") && !shouldSkipControl(h),
  );
  if (inputs.length === 0) return 0;
  const resumeLike = (h: HTMLInputElement) => {
    const bag =
      `${collectFieldHint(h)} ${h.getAttribute("accept") ?? ""} ${h.getAttribute("name") ?? ""} ${h.id ?? ""}`;
    return /resume|cv|curriculum|vitae|attachment|upload|document|cover|pdf|file/i.test(bag);
  };
  const targets = inputs.length === 1 ? inputs : inputs.filter(resumeLike);
  const fillTargets = targets.length > 0 ? targets : [inputs[0]];
  let c = 0;
  for (const h of fillTargets) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      h.files = dt.files;
      h.dispatchEvent(new Event("change", { bubbles: true }));
      h.dispatchEvent(new Event("input", { bubbles: true }));
      c++;
    } catch {
      /* strict pages / shadow DOM */
    }
  }
  return c;
}

function attachResumeTree(doc: Document, file: File): number {
  let n = attachResumeInDocument(doc, file);
  for (const sr of gatherShadowRootsDeep(doc)) {
    n += attachResumeInDocument(sr, file);
  }
  doc.querySelectorAll("iframe").forEach((fr) => {
    try {
      const d = fr.contentDocument;
      if (d?.body) n += attachResumeTree(d, file);
    } catch {
      /* cross-origin */
    }
  });
  return n;
}

function loadResumeFileFromStorage(): Promise<File | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([RESUME_STORAGE_KEY], (r) => {
      const x = r[RESUME_STORAGE_KEY] as { base64?: string; name?: string; mime?: string } | undefined;
      if (!x?.base64 || !x?.name) {
        resolve(null);
        return;
      }
      try {
        const bytes = atob(x.base64);
        const buf = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
        const mime = x.mime || "application/pdf";
        resolve(new File([buf], x.name, { type: mime }));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function fillApplicationFormOnPage(): Promise<string> {
  const profile = await loadApplicationProfile();
  const resumeFile = await loadResumeFileFromStorage();
  const hasProfile =
    profile.email.trim().length > 0 ||
    profile.fullName.trim().length > 0 ||
    profile.firstName.trim().length > 0;

  if (!hasProfile && !resumeFile) {
    return "Save your Application profile in the popup (name / email) or attach a resume (+) before filling forms.";
  }

  await waitMs(200);
  let n = fillTree(document, profile);
  let rCount = resumeFile ? attachResumeTree(document, resumeFile) : 0;

  if (n === 0 && rCount === 0) {
    await scrollTreeForLazyContent(document, window);
    await waitMs(280);
    n = fillTree(document, profile);
    rCount = resumeFile ? attachResumeTree(document, resumeFile) : 0;
  }

  if (n === 0 && rCount === 0) {
    return "No fields matched. Try: click Apply / start the application first, confirm your Application profile has name & email, or say “fill application form” again after the form loads. Embedded apply iframes from another domain cannot be filled by the extension.";
  }

  const parts: string[] = [];
  if (n > 0) parts.push(`Filled ${n} field(s).`);
  if (resumeFile) {
    parts.push(
      rCount > 0
        ? `Attached resume to ${rCount} upload field(s).`
        : "Resume on file but no matching file upload found on this step.",
    );
  }
  parts.push("Review everything and submit yourself.");
  return parts.join(" ");
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Scroll the window and nested overflow regions so lazy-mounted fields (e.g. Microsoft Forms) appear.
 * Recurses into same-origin iframes only.
 */
async function scrollTreeForLazyContent(doc: Document, win: Window): Promise<void> {
  const scrollHeight = Math.max(
    doc.documentElement.scrollHeight,
    doc.body?.scrollHeight ?? 0,
    win.innerHeight,
  );
  const step = Math.max(280, Math.ceil(scrollHeight / 12));
  for (let y = 0; y <= scrollHeight; y += step) {
    win.scrollTo({ top: y, left: 0, behavior: "auto" });
    await waitMs(65);
  }
  win.scrollTo({ top: scrollHeight, left: 0, behavior: "auto" });
  await waitMs(180);

  const overflowEls = Array.from(doc.querySelectorAll<HTMLElement>("*")).filter((el) => {
    try {
      const st = win.getComputedStyle(el);
      const oy = st.overflowY;
      const ox = st.overflowX;
      const scrollableY = oy === "auto" || oy === "scroll";
      const scrollableX = ox === "auto" || ox === "scroll";
      if (!scrollableY && !scrollableX) return false;
      return el.scrollHeight > el.clientHeight + 40 || el.scrollWidth > el.clientWidth + 40;
    } catch {
      return false;
    }
  });
  overflowEls.sort((a, b) => b.scrollHeight - a.scrollHeight);

  for (const el of overflowEls.slice(0, 14)) {
    const maxY = el.scrollHeight - el.clientHeight;
    if (maxY > 8) {
      const innerStep = Math.max(100, Math.ceil(maxY / 10));
      for (let t = 0; t <= maxY; t += innerStep) {
        el.scrollTop = t;
        await waitMs(55);
      }
      el.scrollTop = maxY;
      await waitMs(120);
    }
    const maxX = el.scrollWidth - el.clientWidth;
    if (maxX > 8) {
      for (let t = 0; t <= maxX; t += Math.max(80, Math.ceil(maxX / 8))) {
        el.scrollLeft = t;
        await waitMs(45);
      }
    }
  }

  const iframes = Array.from(doc.querySelectorAll<HTMLIFrameElement>("iframe"));
  for (const fr of iframes) {
    try {
      const d = fr.contentDocument;
      const w = fr.contentWindow;
      if (d && w) await scrollTreeForLazyContent(d, w);
    } catch {
      /* cross-origin */
    }
  }
}

function isClickableVisible(el: HTMLElement): boolean {
  if (shouldSkipControl(el)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 3 && r.height > 3 && r.bottom > 0;
}

/**
 * Clicks Next / Continue / Save and continue on modals or main flow.
 * Skips final Submit — user must confirm.
 */
export async function advanceMultiStepWizard(maxSteps = 28): Promise<number> {
  let clicks = 0;
  for (let i = 0; i < maxSteps; i++) {
    await waitMs(650);
    const dialog = document.querySelector('[role="dialog"]');
    const root: Document | Element = dialog ?? document.body;
    const bodyText = root.textContent ?? "";
    if (
      /application submitted|thank you for applying|you'?ve applied|already applied|submitted successfully|successfully submitted/i.test(
        bodyText,
      )
    ) {
      break;
    }

    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>("button, a[role='button'], input[type='submit']"),
    );
    const nextBtn = candidates.find((b) => {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      if (!isClickableVisible(b)) return false;
      const raw = (b.textContent ?? "").trim();
      const t = raw.toLowerCase();
      const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
      if (/\bsubmit\b|\bsend application\b|\bapply now\b|\bfinish\b/i.test(`${t} ${aria}`)) return false;
      const compact = raw.toLowerCase().replace(/\s+/g, " ");
      return (
        /^(next|continue|proceed|review)$/.test(compact) || /^save (and|&) continue$/.test(compact)
      );
    });

    if (nextBtn) {
      nextBtn.click();
      clicks++;
      await waitMs(1100);
      continue;
    }

    const primary = root.querySelector<HTMLElement>(
      "button[data-automation-id='bottom-nav-next'], button[data-easy-apply-next-button], .jobs-easy-apply-footer button.artdeco-button--primary",
    );
    if (primary && !primary.disabled && isClickableVisible(primary)) {
      const pt = (primary.textContent ?? "").trim().toLowerCase();
      if (!/\bsubmit\b/.test(pt)) {
        primary.click();
        clicks++;
        await waitMs(1100);
        continue;
      }
    }
    break;
  }
  return clicks;
}

/** Primary CTA on many ATS pages before the form appears (Workday, Greenhouse, etc.). */
async function clickEntryApplyIfPresent(): Promise<boolean> {
  const byAutomation = document.querySelectorAll<HTMLElement>(
    "[data-automation-id='apply'], [data-automation-id='Apply'], button[data-qa='apply'], a[data-qa='apply']",
  );
  for (const el of byAutomation) {
    if (!shouldSkipControl(el) && isClickableVisible(el)) {
      el.click();
      await waitMs(500);
      return true;
    }
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("button, a[role='button'], input[type='button'], a[class*='button']"),
  );
  for (const el of candidates) {
    if (shouldSkipControl(el) || !isClickableVisible(el)) continue;
    const raw = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const aria = (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
    if (!raw && !aria) continue;
    if (raw.length > 56) continue;
    const label = `${raw} ${aria}`.toLowerCase();
    if (
      /\b(filter|saved search|subscribe|alert|share|follow|sign in|log in|dismiss|close|cancel|save job)\b/i.test(
        label,
      )
    ) {
      continue;
    }
    const tryText = raw || aria;
    if (
      /^(apply|apply now|apply manually|start( application)?|begin application)$/i.test(tryText) ||
      /^apply for this job$/i.test(tryText)
    ) {
      el.click();
      await waitMs(500);
      return true;
    }
  }
  return false;
}

/** After navigation: optional Apply click, fill fields, attach resume, then advance wizard steps (no final Submit). */
export async function fillApplicationFormFullOnPage(): Promise<string> {
  const profile = await loadApplicationProfile();
  const resumeFile = await loadResumeFileFromStorage();
  const hasProfile =
    profile.email.trim().length > 0 ||
    profile.fullName.trim().length > 0 ||
    profile.firstName.trim().length > 0;

  if (!hasProfile && !resumeFile) {
    return "Save your Application profile (name / email) or attach a resume (+) before filling forms.";
  }

  await waitMs(900);

  let opened = await clickEntryApplyIfPresent();
  if (opened) await waitMs(2600);

  let n = fillTree(document, profile);
  let rCount = resumeFile ? attachResumeTree(document, resumeFile) : 0;

  if (n === 0 && rCount === 0) {
    await scrollTreeForLazyContent(document, window);
    await waitMs(400);
    n = fillTree(document, profile);
    rCount = resumeFile ? attachResumeTree(document, resumeFile) : 0;
  }

  if (n === 0 && rCount === 0) {
    opened = (await clickEntryApplyIfPresent()) || opened;
    if (opened) await waitMs(2600);
    await scrollTreeForLazyContent(document, window);
    await waitMs(450);
    n = fillTree(document, profile);
    rCount = resumeFile ? attachResumeTree(document, resumeFile) : 0;
  }

  if (n === 0 && rCount === 0) {
    await waitMs(1200);
    await scrollTreeForLazyContent(document, window);
    await waitMs(350);
    n = fillTree(document, profile);
    rCount = resumeFile ? attachResumeTree(document, resumeFile) : 0;
  }

  const wizardClicks = await advanceMultiStepWizard(32);

  const parts: string[] = [];
  if (n > 0) parts.push(`Filled ${n} field(s) on this screen.`);
  else parts.push("No empty fields matched on this screen (you may be on an intro step).");

  if (resumeFile) {
    parts.push(
      rCount > 0
        ? `Attached resume to ${rCount} upload field(s).`
        : "Resume on file but no matching upload field on this screen.",
    );
  }
  if (wizardClicks > 0) {
    parts.push(`Advanced ${wizardClicks} step(s) (Next/Continue). Final Submit is yours to click.`);
  }
  if (n === 0 && rCount === 0 && wizardClicks === 0) {
    return "Nothing matched yet — fields may be below the scroll (run again after scrolling), inside a cross-origin iframe, or use labels we don’t map yet. Microsoft Forms often needs a second run after the page fully loads.";
  }
  parts.push("Review all answers before submitting.");
  return parts.join(" ");
}
