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
  "review_state", "favcrm_campaign_id", "estimate", "delivery_stats", "sender_status", "approvals", "proposals"
]);

const MAX_SUBJECT = 200;
const MAX_PREHEADER = 300;
// The contract caps one collection at 500 items (GADGET_LIMITS.collectionItems);
// the definition declares the same bound, and these enforce it in the model.
const MAX_ACCOUNTS = 500;
const MAX_EXCLUSIONS = 500;
const MAX_SECTIONS = 40;
const MAX_CUSTOM_HTML = 200 * 1024;
const MAX_LABEL = 200;
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
  // `custom_html` is stored as pasted and sanitized at the send boundary —
  // `sanitizeCustomHtml` below is that boundary's pure half.
  if (type === "custom_html") section.html = cleanMultiline(input.html, MAX_CUSTOM_HTML);
  return section;
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
// custom_html sanitization — the send-time boundary's pure half.
//
// Pasted markup (Stripo/BEE/Mailchimp exports) arrives whole. The contract:
// scripts, forms, tracking pixels, inline `on*` handlers and `javascript:`
// URLs never reach a send. This is the pure, testable half; the domain
// service's `sectionsToHtml` applies the same rules server-side before the
// FavCRM mirror — two implementations of one contract, kept honest by the
// shared test in test/unit.
// ---------------------------------------------------------------------------

const BLOCKED_TAGS = /<\/?\s*(script|form|iframe|object|embed|link|meta|base|noscript|template)\b[^>]*>/gi;
const EVENT_HANDLERS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL = /(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi;
const DATA_URL = /(href|src)\s*=\s*(["']?)\s*data:(?!image\/)[^"'>\s]*\2/gi;
// 1x1 / zero-size tracking pixels: <img> whose declared size collapses to a dot.
const TRACKING_PIXEL = /<img\b[^>]*?(?:width\s*=\s*["']?(?:0|1)["']?|height\s*=\s*["']?(?:0|1)["']?)[^>]*?(?:width\s*=\s*["']?(?:0|1)["']?|height\s*=\s*["']?(?:0|1)["']?)?[^>]*>/gi;

/** Strip a custom_html block to sendable markup. Idempotent — safe to re-run. */
export function sanitizeCustomHtml(html) {
  let out = cleanMultiline(html, MAX_CUSTOM_HTML);
  out = out.replace(BLOCKED_TAGS, "");
  out = out.replace(EVENT_HANDLERS, "");
  out = out.replace(JAVASCRIPT_URL, "");
  out = out.replace(DATA_URL, "");
  // A pixel is only tracking when it is both invisible AND sized to a dot —
  // remove 1x1/0x0 images wholesale rather than guessing at intent.
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const w = tag.match(/width\s*=\s*["']?(\d+)/i);
    const h = tag.match(/height\s*=\s*["']?(\d+)/i);
    if (w && h && Number(w[1]) <= 1 && Number(h[1]) <= 1) return "";
    if (w && Number(w[1]) === 0) return "";
    if (h && Number(h[1]) === 0) return "";
    return tag;
  });
  // <style> stays — email clients need it and it carries no script. What it
  // cannot carry: a behaviour url or an expression, both IE-era script sinks.
  out = out.replace(/expression\s*\(|behaviour\s*:|behavior\s*:/gi, "");
  return out;
}

/** Whether a custom_html section survives sanitization with content left. */
export function customHtmlSendable(html) {
  return sanitizeCustomHtml(html).replace(/<[^>]*>/g, "").trim().length > 0;
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
 * Apply one declarative command to a draft. Returns `{ ok: true, draft }` or a
 * refusal envelope. `expectedRevision` is compare-and-swap — a stale base is a
 * conflict value, not an exception.
 */
export function applyCommandToDraft(draft, command, { expectedRevision = null, revision = 0 } = {}) {
  if (!command || typeof command !== "object") return issue("invalid_command", "Command is not an object.");
  const kind = command.kind;
  if (expectedRevision !== null && expectedRevision !== revision) {
    return { ok: false, code: "revision_conflict", message: `Draft moved past revision ${expectedRevision} — read the current version before writing.` };
  }
  const next = { ...normalizeDraft(draft) };

  if (kind === "state.set") {
    const path = command.path;
    if (!pathMutable(path)) return issue("not_mutable", `${path} is not a draft field commands may write.`);
    next[path] = COLLECTION_NORMALIZERS[path] ? COLLECTION_NORMALIZERS[path](command.value) : cleanString(command.value, 64 * 1024);
    return { ok: true, draft: next };
  }
  if (kind === "state.merge") {
    const value = command.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return issue("invalid_command", "state.merge needs an object value.");
    for (const [path, fieldValue] of Object.entries(value)) {
      if (!pathMutable(path)) return issue("not_mutable", `${path} is not a draft field commands may write.`);
      next[path] = COLLECTION_NORMALIZERS[path] ? COLLECTION_NORMALIZERS[path](fieldValue) : cleanString(fieldValue, 64 * 1024);
    }
    return { ok: true, draft: next };
  }
  if (kind === "collection.add") {
    const path = command.path;
    if (!pathMutable(path) || !COLLECTION_FIELDS.has(path)) return issue("not_mutable", `${path} is not a collection commands may write.`);
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
 * Sections → sendable HTML, the facet-side half of `sectionsToHtml`. The domain
 * service renders the canonical version host-side before the FavCRM mirror;
 * this exists for the canvas preview and the sanitize contract test — two
 * implementations of one contract, kept honest by test/unit/sanitize.test.ts.
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
    if (section.type === "custom_html" && section.html) parts.push(sanitizeCustomHtml(section.html));
  }
  return parts.join("\n");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
