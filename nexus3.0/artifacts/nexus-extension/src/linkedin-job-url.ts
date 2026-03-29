/**
 * Shared LinkedIn job search URL builder for background + content (same navigation target).
 */

export function deriveSearchQuery(task: string): string {
  const stripped = task
    .replace(/\s*(from|on)\s+linkedin\.?$/i, "")
    .trim();
  return stripped
    .replace(/^(search\s+(for\s+)?|find\s+(me\s+)?|look\s+up\s+|google\s+|browse\s+)/i, "")
    .trim();
}

export function parseJobParts(task: string): { title?: string; company?: string; location?: string } {
  /** Anchor on "for (a) … job" so we never capture from the leading "apply". */
  const titleMatch = task.match(
    /\bfor\s+(?:a\s+)?(.+?)\s+(?:job|role|position)\b/i,
  );
  const companyMatch = task.match(/(?:at|@)\s+([A-Za-z][A-Za-z0-9\s]+)/i);
  const locationMatch = task.match(/\b(?:in|near)\s+([A-Za-z][A-Za-z\s,]+?)(?:\s+(?:for|at|from|on)\b|$)/i);
  return {
    title: titleMatch?.[1]?.trim(),
    company: companyMatch?.[1]?.trim(),
    location: locationMatch?.[1]?.trim(),
  };
}

/** Role keywords only — no "apply for…" sentence in LinkedIn’s search box. */
export function jobKeywordsForLinkedIn(task: string): string {
  const { title, company } = parseJobParts(task);
  let kw = [title, company].filter(Boolean).join(" ").trim();

  if (!kw || kw.length < 2 || /^(apply|search|find|a)$/i.test(kw)) {
    let s = task
      .replace(/\s*(from|on)\s+linkedin\.?$/i, "")
      .replace(/^(?:please\s+)?(?:i\s+(?:want|need)\s+to\s+)?/i, "")
      .replace(/^apply\s+for\s+(?:a\s+)?/i, "")
      .replace(/^apply\s+to\s+/i, "")
      .replace(/^search\s+for\s+(?:a\s+)?/i, "")
      .replace(/^find\s+(?:me\s+)?(?:a\s+)?/i, "")
      .replace(/\b(?:the\s+)?(?:job|role|position)s?\s*$/i, "")
      .trim();
    kw = s.length >= 2 ? s : deriveSearchQuery(task);
  }

  return kw.replace(/\s{2,}/g, " ").trim() || "jobs";
}

export function buildLinkedInSearchUrl(task: string): string {
  const { location } = parseJobParts(task);
  const searchQuery = jobKeywordsForLinkedIn(task);
  const loc = location ?? "Remote";
  return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(searchQuery)}&location=${encodeURIComponent(loc)}&f_AL=true`;
}

/** Already on LinkedIn job search results — content can run without another navigation. */
export function isLinkedInJobSearchUrl(url: string | undefined): boolean {
  return !!url && /linkedin\.com\/jobs\/search/i.test(url);
}

/** Single job posting — Easy Apply can run without opening search. */
export function isLinkedInJobViewUrl(url: string | undefined): boolean {
  return !!url && /linkedin\.com\/jobs\/view\//i.test(url);
}

export function isLinkedInUrl(url: string | undefined): boolean {
  return !!url && url.includes("linkedin.com");
}

/**
 * True when current tab URL already matches this task’s job-search query (no redirect needed).
 */
function linkedInJobSearchMatchesTask(url: string | undefined, task: string): boolean {
  if (!url || !isLinkedInJobSearchUrl(url)) return false;
  try {
    const u = new URL(url);
    const cur = decodeURIComponent(u.searchParams.get("keywords") ?? "")
      .trim()
      .toLowerCase();
    const want = jobKeywordsForLinkedIn(task).trim().toLowerCase();
    return want.length > 0 && cur === want;
  } catch {
    return false;
  }
}

/**
 * If true, background navigates the tab to LinkedIn job search for this task.
 * You do **not** need LinkedIn open first — any normal https tab (not chrome:// new tab) works.
 */
export function linkedInJobTaskNeedsSearchNavigation(url: string | undefined, task: string): boolean {
  if (!isLinkedInUrl(url)) return true;
  if (isLinkedInJobViewUrl(url)) return false;
  if (isLinkedInJobSearchUrl(url) && linkedInJobSearchMatchesTask(url, task)) return false;
  return true;
}
