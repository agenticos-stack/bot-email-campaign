// Email Campaign blueprint — pure draft normalization and validation.
//
// No I/O (PAT-002): `server.js` and `client.js` both import this unchanged —
// the facet validates what the client previews. A function that needs the
// network, storage, or the clock does not belong here; the caller passes
// `now`/`id` in.
//
// THE DRAFT LIVES IN FACET STORAGE (kickoff 6837c). The campaigns domain
// service reads the gadget's own `state_json` for send — this file shapes the
// one draft both sides agree on: the facet's `campaigns` table row and the
// `state_json` mirror the bridge writes before a governed action.

// The flat archive ships raw .js members only, so this file cannot import
// `../definition.ts` — these constants are pinned to the definition's declared
// values by `test/unit/definition-parity.test.ts`, which fails on drift.
export const SECTION_TYPES = Object.freeze(["heading", "body", "cta", "image", "custom_html"]);

/** What `state_json`'s `mutable` allowlist permits — mirrored, never re-derived. */
export const MUTABLE_PATHS = Object.freeze([
  "audience_source", "audience_segment", "audience_segment[].segment_id", "audience_segment[].label",
  "audience_accounts", "audience_accounts[].account_id", "audience_accounts[].name", "audience_accounts[].email",
  "audience_exclusions", "audience_exclusions[].kind", "audience_exclusions[].id", "audience_exclusions[].label",
  "subject", "preheader",
  "sections", "sections[].type", "sections[].heading", "sections[].body",
  "sections[].cta_label", "sections[].cta_url", "sections[].image_url", "sections[].html",
  "scheduled_for"
]);

/** Outcome fields the domain service owns — never writable through a command. */
export const OUTCOME_PATHS = Object.freeze([
  "review_state", "favcrm_campaign_id", "undo_until", "last_test_at", "last_test_to",
  "estimate", "delivery_stats", "sender_status", "approvals", "proposals"
]);

const MAX_SUBJECT = 200;
const MAX_PREHEADER = 300;
// The definition declares 1000/1050 as product intent; the shared contract
// still clamps every collection at 500 items (GADGET_LIMITS.collectionItems),
// so 500 is the bound a draft can actually hold — enforce that here.
const MAX_ACCOUNTS = 500;
const MAX_EXCLUSIONS = 500;
const MAX_SECTIONS = 40;
const MAX_LABEL = 200;
// A pasted full-email document can be large; the cap bounds the blob, not
// its content — nothing here inspects markup.
const MAX_CUSTOM_HTML = 200 * 1024;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISOISH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function newId(prefix = "c") {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function cleanString(value, max = MAX_LABEL) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanMultiline(value, max = 20_000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** One section row, normalized to its declared type; unknown types drop. */
export function normalizeSection(input) {
  if (!input || typeof input !== "object") return null;
  const type = cleanString(input.type, 20);
  if (!SECTION_TYPES.includes(type)) return null;
  const section = { id: cleanString(input.id, 64) || newId("s"), type };
  if (type === "heading") section.heading = cleanString(input.heading, MAX_SUBJECT);
  if (type === "body") section.body = cleanMultiline(input.body);
  if (type === "cta") {
    section.cta_label = cleanString(input.cta_label, MAX_LABEL);
    section.cta_url = cleanUrl(input.cta_url);
  }
  if (type === "image") section.image_url = cleanUrl(input.image_url);
  // `custom_html` is stored verbatim — the boundary is the sandboxed preview
  // iframe and the recipient's client, never a regex over markup.
  if (type === "custom_html") section.html = cleanMultiline(input.html, MAX_CUSTOM_HTML);
  // `origin` is provenance the facet sets when a block lands (only the
  // proposal-accept path sets it today). Carried so a whole-draft save keeps
  // the marker; it is advisory, not a trust boundary — a whole-array write can
  // carry any marker, so the review card also lists the markup's facts.
  const origin = normalizeOrigin(input.origin);
  if (origin) section.origin = origin;
  return section;
}

function normalizeOrigin(input) {
  if (!input || typeof input !== "object") return null;
  const via = cleanString(input.via, 20);
  if (via !== "proposal") return null;
  return { via, proposalId: cleanString(input.proposalId, 64), label: cleanString(input.label, MAX_LABEL) };
}

/**
 * The section types a write names that the draft cannot carry. An undeclared
 * type is refused rather than silently dropped, so an agent learns the
 * boundary instead of losing content to normalization.
 */
export function unsupportedSectionTypes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((row) => cleanString(row?.type, 20)).filter((t) => t && !SECTION_TYPES.includes(t)))];
}

export function normalizeSections(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeSection).filter(Boolean).slice(0, MAX_SECTIONS);
}

function cleanUrl(value) {
  const url = cleanString(value, 2048);
  if (!url) return "";
  // http(s) only — a javascript:/data: URL here is a stored injection, not a link.
  return /^https?:\/\//i.test(url) ? url : "";
}

export function normalizeAudienceAccount(input) {
  if (!input || typeof input !== "object") return null;
  const accountId = cleanString(input.account_id ?? input.id, 128);
  if (!accountId) return null;
  return {
    account_id: accountId,
    name: cleanString(input.name, MAX_LABEL),
    email: EMAILISH.test(input.email) ? cleanString(input.email, 320) : ""
  };
}

export function normalizeAudienceAccounts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const row of list) {
    const account = normalizeAudienceAccount(row);
    if (!account || seen.has(account.account_id)) continue;
    seen.add(account.account_id);
    out.push(account);
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return out;
}

export function normalizeExclusion(input) {
  if (!input || typeof input !== "object") return null;
  const kind = input.kind === "campaign" ? "campaign" : "account";
  const id = cleanString(input.id, 128);
  if (!id) return null;
  return { kind, id, label: cleanString(input.label, MAX_LABEL) };
}

export function normalizeExclusions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const row of list) {
    const exclusion = normalizeExclusion(row);
    if (!exclusion || seen.has(`${exclusion.kind}:${exclusion.id}`)) continue;
    seen.add(`${exclusion.kind}:${exclusion.id}`);
    out.push(exclusion);
    if (out.length >= MAX_EXCLUSIONS) break;
  }
  return out;
}

export function normalizeSegment(input) {
  if (!input || typeof input !== "object") return null;
  const segmentId = cleanString(input.segment_id ?? input.id, 128);
  if (!segmentId) return null;
  return { segment_id: segmentId, label: cleanString(input.label, MAX_LABEL) };
}

/**
 * The whole editable draft, normalized. Every field is a reference or text —
 * never a materialized recipient list (FavCRM owns resolution at send).
 */
export function normalizeDraft(input = {}) {
  const source = cleanString(input.audience_source ?? input.source, 20);
  const sections = normalizeSections(input.sections);
  return {
    title: cleanString(input.title, MAX_SUBJECT),
    audience_source: ["all", "segment", "individual"].includes(source) ? source : "all",
    audience_segment: input.audience_source === "segment" || input.segment
      ? (Array.isArray(input.audience_segment) ? input.audience_segment : [input.segment ?? input.audience_segment])
          .map(normalizeSegment).filter(Boolean).slice(0, 1)
      : [],
    audience_accounts: normalizeAudienceAccounts(input.audience_accounts ?? input.accounts),
    audience_exclusions: normalizeExclusions(input.audience_exclusions ?? input.exclusions),
    subject: cleanString(input.subject, MAX_SUBJECT),
    preheader: cleanString(input.preheader, MAX_PREHEADER),
    sections,
    scheduled_for: cleanScheduledFor(input.scheduled_for ?? input.schedule)
  };
}

function cleanScheduledFor(value) {
  const text = cleanString(value, 64);
  return ISOISH.test(text) ? text : "";
}

/**
 * The audience fingerprint an estimate binds to. Any audience change must
 * invalidate the last estimate — compare keys, not object identity.
 */
export function audienceKey(draft) {
  const d = normalizeDraft(draft);
  return JSON.stringify({
    source: d.audience_source,
    segment: d.audience_segment.map((s) => s.segment_id).sort(),
    accounts: d.audience_accounts.map((a) => a.account_id).sort(),
    exclusions: d.audience_exclusions.map((e) => `${e.kind}:${e.id}`).sort()
  });
}

/**
 * The content fingerprint an approval binds to — the exact saved draft, not a
 * description. Edits after approval must require fresh approval; a change here
 * is how "the draft moved" is detected.
 */
export function draftFingerprint(draft) {
  return JSON.stringify(normalizeDraft(draft));
}

/** What "sendable" means — the review checklist's machine half. */
export function missingForSend(draft) {
  const missing = [];
  if (!cleanString(draft?.subject)) missing.push("subject");
  if (!normalizeSections(draft?.sections).length) missing.push("sections");
  return missing;
}

// ---------------------------------------------------------------------------
// The draft write boundary — what a command may touch, and when.
//
// `mutable` parity: the allowlist below mirrors the definition, and the
// lifecycle lock mirrors `mutableWhen` — a draft whose review_state has left
// the editable set is read-only here exactly as it is through `state_json`.
// ---------------------------------------------------------------------------

/** The review states in which the draft's mutable surface is open — the
 *  definition's `mutableWhen.in`, pinned by `test/unit/definition-parity.test.ts`. */
export const OPEN_REVIEW_STATES = Object.freeze(["drafting", "in_review", "approved"]);

/** Whether a lifecycle value has closed the mutable surface (mutableWhen). */
export function draftLocked(reviewState) {
  return typeof reviewState === "string" && reviewState !== "" && !OPEN_REVIEW_STATES.includes(reviewState);
}

// ---------------------------------------------------------------------------
// The declarative command surface, applied to a facet-stored draft.
//
// `applyCommand` mirrors the definition's `commands` against the facet's own
// draft row — the kickoff's "command surface in the facet". It enforces the
// same `mutable` allowlist the `state_json` path enforces, so a command means
// the same thing whether the agent writes state_json or the client writes
// here. Refusals return `{ ok: false, code, message }` — never throw (a facet
// exception breaks the DO output gate).
// ---------------------------------------------------------------------------

function issue(code, message) {
  return { ok: false, issues: [{ code, severity: "error", message }] };
}

function pathMutable(path) {
  if (!path || typeof path !== "string") return false;
  if (OUTCOME_PATHS.includes(path)) return false;
  if (MUTABLE_PATHS.includes(path)) return true;
  // `sections[].x` and `collection.update` item fields — the `[]` form above
  // is the allowlist entry for any row inside the collection.
  const collectionPath = path.replace(/\[\]$/, "[]");
  return MUTABLE_PATHS.includes(collectionPath);
}

const COLLECTION_FIELDS = new Set([
  "audience_segment", "audience_accounts", "audience_exclusions", "sections"
]);

const COLLECTION_NORMALIZERS = {
  audience_segment: (rows) => (Array.isArray(rows) ? rows : [rows]).map(normalizeSegment).filter(Boolean).slice(0, 1),
  audience_accounts: normalizeAudienceAccounts,
  audience_exclusions: normalizeExclusions,
  sections: normalizeSections
};

/**
 * Refuse a `sections` write that names a type the draft cannot carry. An
 * undeclared type would render nothing on the send path, so accepting the
 * write would promise a block no send can deliver.
 */
function refusedSectionWrite(kind, path, command) {
  if (path !== "sections") return null;
  const incoming =
    kind === "collection.add" ? [command.item ?? command.value]
    : kind === "collection.update" ? [command.value ?? command.patch ?? {}]
    : Array.isArray(command.value) ? command.value : [];
  const bad = unsupportedSectionTypes(incoming);
  if (!bad.length) return null;
  return issue(
    "unsupported_section",
    `Section type ${bad.map((b) => `"${b}"`).join(", ")} is not supported — sections are ${SECTION_TYPES.join(", ")}.`
  );
}

/**
 * Apply one declarative command to a draft. Returns `{ ok: true, draft }` or a
 * refusal envelope. `expectedRevision` is compare-and-swap — a stale base is a
 * conflict value, not an exception. `reviewState` is the campaign's effective
 * review state (the outcome mirror, or the facet status mapped): outside the
 * open set the mutable surface locks, mirroring the definition's mutableWhen.
 */
export function applyCommandToDraft(draft, command, { expectedRevision = null, revision = 0, reviewState = null } = {}) {
  if (!command || typeof command !== "object") return issue("invalid_command", "Command is not an object.");
  const kind = command.kind;
  if (expectedRevision !== null && expectedRevision !== revision) {
    return { ok: false, code: "revision_conflict", message: `Draft moved past revision ${expectedRevision} — read the current version before writing.` };
  }
  const mutating = ["state.set", "state.merge", "collection.add", "collection.update", "collection.remove"].includes(kind);
  if (mutating && draftLocked(reviewState)) {
    return { ok: false, code: "state_locked", message: `Draft is read-only while review_state is "${reviewState}" — unschedule or undo through the domain to reopen it.` };
  }
  const next = { ...normalizeDraft(draft) };

  if (kind === "state.set" || kind === "state.merge") {
    if (kind === "state.merge" && (typeof command.value !== "object" || command.value === null || Array.isArray(command.value))) {
      return issue("invalid_command", "state.merge needs an object value.");
    }
    const pairs = kind === "state.set" ? [[command.path, command.value]] : Object.entries(command.value);
    for (const [path, fieldValue] of pairs) {
      if (!pathMutable(path)) return issue("not_mutable", `${path} is not a draft field commands may write.`);
      const refused = refusedSectionWrite(kind, path, { value: fieldValue });
      if (refused) return refused;
      next[path] = COLLECTION_NORMALIZERS[path] ? COLLECTION_NORMALIZERS[path](fieldValue) : cleanString(fieldValue, 64 * 1024);
    }
    return { ok: true, draft: next };
  }
  if (kind === "collection.add") {
    const path = command.path;
    if (!pathMutable(path) || !COLLECTION_FIELDS.has(path)) return issue("not_mutable", `${path} is not a collection commands may write.`);
    const refused = refusedSectionWrite(kind, path, command);
    if (refused) return refused;
    const rows = [...(next[path] ?? []), command.item ?? command.value];
    const normalized = COLLECTION_NORMALIZERS[path](rows);
    next[path] = normalized;
    return { ok: true, draft: next };
  }
  if (kind === "collection.update") {
    const path = command.path;
    if (!pathMutable(path) || !COLLECTION_FIELDS.has(path)) return issue("not_mutable", `${path} is not a collection commands may write.`);
    const itemId = command.itemId ?? command.id;
    const patch = command.value ?? command.patch ?? {};
    if (patch && typeof patch === "object" && typeof patch.type === "string" && !SECTION_TYPES.includes(cleanString(patch.type, 20))) {
      return issue("unsupported_section", `Section type "${cleanString(patch.type, 20)}" is not supported — sections are ${SECTION_TYPES.join(", ")}. Pasted HTML is refused until the send path can sanitize it.`);
    }
    const rows = (next[path] ?? []).map((row) => (row.id === itemId || row.account_id === itemId || row.segment_id === itemId) ? { ...row, ...patch } : row);
    next[path] = COLLECTION_NORMALIZERS[path](rows);
    return { ok: true, draft: next };
  }
  if (kind === "collection.remove") {
    const path = command.path;
    if (!pathMutable(path) || !COLLECTION_FIELDS.has(path)) return issue("not_mutable", `${path} is not a collection commands may write.`);
    const itemId = command.itemId ?? command.id;
    next[path] = (next[path] ?? []).filter((row) => !(row.id === itemId || row.account_id === itemId || row.segment_id === itemId));
    return { ok: true, draft: next };
  }
  // `selection.set` / `proposal.accept` / `proposal.reject` are handled by the
  // facet (selection is session state; proposals reconcile against the stored
  // proposal rows) — they arrive here only as drafts, which carry neither.
  return issue("unsupported_command", `${kind} is not a draft-field command.`);
}

/** The draft as `state_json` field rows — the shape the domain service reads. */
export function draftToState(draft) {
  const d = normalizeDraft(draft);
  return {
    audience_source: d.audience_source,
    audience_segment: d.audience_segment,
    audience_accounts: d.audience_accounts,
    audience_exclusions: d.audience_exclusions,
    subject: d.subject,
    preheader: d.preheader,
    sections: d.sections,
    scheduled_for: d.scheduled_for
  };
}

/**
 * Sections → preview HTML, the facet-side half of `sectionsToHtml`. The domain
 * service renders the canonical version host-side before the FavCRM mirror;
 * this exists for the canvas preview. One contract both sides keep: typed
 * fields are escaped into fixed tags, and a `custom_html` block is emitted
 * verbatim — markup carried from the draft, whoever wrote it, whose only safe
 * display surface is a `sandbox`ed iframe (no scripts, opaque origin). The
 * writer is disclosed at review (`customHtmlFacts` + `origin`), not enforced:
 * nothing distinguishes pasted markup from agent-written markup at this point,
 * so the gate shows what the markup does instead of a picture of it. Anything
 * the draft cannot carry never reaches the output. The gadget half is covered
 * by test/unit/model.test.ts; the host half by the API's definition↔service
 * continuity test.
 */
export function sectionsToHtml(sections) {
  const parts = [];
  for (const section of normalizeSections(sections)) {
    if (section.type === "heading" && section.heading) parts.push(`<h1>${escapeHtml(section.heading)}</h1>`);
    if (section.type === "body" && section.body) parts.push(`<p>${escapeHtml(section.body).replace(/\n/g, "<br>")}</p>`);
    if (section.type === "cta" && section.cta_url && section.cta_label) {
      parts.push(`<p><a href="${escapeHtml(section.cta_url)}">${escapeHtml(section.cta_label)}</a></p>`);
    }
    if (section.type === "image" && section.image_url) parts.push(`<img src="${escapeHtml(section.image_url)}" alt="">`);
    if (section.type === "custom_html" && section.html) parts.push(section.html);
  }
  return parts.join("\n");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * What a pasted-HTML block does, stated as facts for the review gate — never
 * a verdict, and deliberately NOT a DOM parse: a parser tidies its input and
 * could hide the conditional comments and malformed fragments this exists to
 * disclose. The markup is still emitted verbatim; this names what "verbatim"
 * contains so the approver reads the markup's behaviour, not a rendering of it
 * (rendering is exactly what hides a 1×1 remote pixel, a `display:none` block
 * or an Outlook-only conditional). Patterns over indicators, bounded caps.
 */
export function customHtmlFacts(html) {
  const text = typeof html === "string" ? html : "";
  const links = [];
  const imageHosts = new Set();
  const assetHosts = new Set();
  if (text) {
    const val = (m) => (m[1] ?? m[2] ?? m[3] ?? "").trim();
    // Outbound links — each <a href> that leaves the page, host and href both
    // listed because link text disagreeing with its target is the tell.
    for (const m of text.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const href = val(m);
      const host = urlHost(href);
      if (host && links.length < 24) links.push({ host, href: href.slice(0, 300) });
    }
    // Remote images — a tracking pixel's host is the fact that matters.
    for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const host = urlHost(val(m));
      if (host) imageHosts.add(host);
    }
    // Remote CSS/scripts — <link>/<script src>, @import, url(http…) in styles.
    for (const m of text.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const host = urlHost(val(m));
      if (host) assetHosts.add(host);
    }
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?(https?:\/\/[^\s"')]+)/gi)) {
      const host = urlHost(m[1]);
      if (host) assetHosts.add(host);
    }
    for (const m of text.matchAll(/\burl\(\s*["']?(https?:\/\/[^\s"')]+)["']?\s*\)/gi)) {
      const host = urlHost(m[1]);
      if (host) assetHosts.add(host);
    }
  }
  const count = (re) => (text.match(re) ?? []).length;
  return {
    bytes: new TextEncoder().encode(text).length,
    links,
    imageHosts: [...imageHosts],
    assetHosts: [...assetHosts],
    // Hidden or zero-size content: display/visibility, mso-hide, 0–1px boxes,
    // zero font/line-height, opacity:0 — the tricks rendering conceals.
    hiddenCount:
      count(/display\s*:\s*none/gi) +
      count(/visibility\s*:\s*hidden/gi) +
      count(/mso-hide\s*:\s*all/gi) +
      count(/\b(?:width|height)\s*=\s*["']?[01](?:px)?["'\s/>]/gi) +
      count(/\b(?:width|height|font-size|line-height)\s*:\s*(?:0(?:px|pt|em)?|1px)\b/gi) +
      count(/opacity\s*:\s*0(?:\.0+)?(?!\d)/gi),
    hasBaseTag: /<base\b/i.test(text),
    conditionalCount: count(/<!--\s*\[if\b/gi)
  };
}

function urlHost(value) {
  const url = cleanString(value, 2048);
  if (!/^https?:\/\//i.test(url)) return "";
  try { return new URL(url).host; } catch { return "" }
}

/**
 * Mark the `custom_html` blocks a proposal's accepted command batch touched —
 * a new id or a changed `html` — with `origin: {via:"proposal", …}`. The
 * review step then shows "staged by a proposal" beside "added by a direct
 * edit", so agent-staged markup and directly-written markup never look alike
 * at the gate. Returns the count marked; the caller persists the draft.
 */
export function stampProposalSections(sections, before, { proposalId = "", label = "" } = {}) {
  const previous = new Map((before ?? []).map((s) => [s?.id, s?.html]));
  let marked = 0;
  for (const section of sections ?? []) {
    if (section?.type !== "custom_html") continue;
    if (previous.get(section.id) === section.html) continue;
    section.origin = { via: "proposal", proposalId, label };
    marked += 1;
  }
  return marked;
}

/**
 * Collect every `custom_html` section inside an arbitrary payload — a
 * proposal's staged commands nest them differently than a draft does, so this
 * walks rather than shapes. Depth-bounded; returns the section objects.
 */
export function findCustomHtmlSections(value, depth = 0, out = []) {
  if (depth > 6 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) findCustomHtmlSections(item, depth + 1, out);
    return out;
  }
  if (value.type === "custom_html") out.push(value);
  for (const item of Object.values(value)) findCustomHtmlSections(item, depth + 1, out);
  return out;
}
