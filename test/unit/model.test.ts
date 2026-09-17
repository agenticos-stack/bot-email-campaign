// Node unit tests for the pure Email Campaign model. No network, no D1, no
// facet — model.js has no I/O beyond the platform crypto API and the clock the
// caller passes in. These pin the draft both the facet's `campaigns` row and
// the `state_json` mirror agree on, plus the custom_html refusal boundary and
// the review-state lifecycle lock.
import { describe, expect, it } from "vitest";
import {
  MUTABLE_PATHS,
  OPEN_REVIEW_STATES,
  OUTCOME_PATHS,
  SECTION_TYPES,
  applyCommandToDraft,
  audienceKey,
  draftFingerprint,
  draftLocked,
  draftToState,
  missingForSend,
  normalizeDraft,
  normalizeSection,
  normalizeSections,
  sectionsToHtml,
  unsupportedSectionTypes
} from "../../src/model.js";

describe("normalizeSection", () => {
  it("keeps each declared type and drops everything else — custom_html included", () => {
    for (const type of ["heading", "body", "cta", "image"]) {
      expect(normalizeSection({ type })?.type).toBe(type);
    }
    expect(SECTION_TYPES).not.toContain("custom_html");
    // Refused, not silently rendered: pasted markup is dropped like any other
    // unknown type at normalization, and named at the write boundary below.
    expect(normalizeSection({ type: "custom_html" })).toBeNull();
    expect(normalizeSection({ type: "banner" })).toBeNull();
    expect(normalizeSection({ type: "script" })).toBeNull();
    expect(normalizeSection(null)).toBeNull();
  });

  it("assigns a stable id when none is given", () => {
    const a = normalizeSection({ type: "heading", heading: "Hi" });
    expect(a?.id).toMatch(/^s_[0-9a-f]+$/);
  });

  it("carries only the fields its type owns", () => {
    const cta = normalizeSection({ type: "cta", cta_label: "Go", cta_url: "https://x.test", heading: "stray" });
    expect(cta).toMatchObject({ cta_label: "Go", cta_url: "https://x.test" });
    expect(cta).not.toHaveProperty("heading");
    expect(cta).not.toHaveProperty("html");
  });

  it("refuses a non-http(s) cta or image url — a stored javascript: is an injection", () => {
    expect(normalizeSection({ type: "cta", cta_label: "x", cta_url: "javascript:alert(1)" })?.cta_url).toBe("");
    expect(normalizeSection({ type: "image", image_url: "data:text/html;base64,AA==" })?.image_url).toBe("");
    expect(normalizeSection({ type: "image", image_url: "https://cdn.test/a.png" })?.image_url).toBe(
      "https://cdn.test/a.png"
    );
  });
});

describe("normalizeSections", () => {
  it("drops invalid rows and caps at the section limit", () => {
    const rows = normalizeSections([
      { type: "heading", heading: "A" },
      { type: "nope" },
      { type: "body", body: "B" }
    ]);
    expect(rows.map((s) => s.type)).toEqual(["heading", "body"]);
    const many = normalizeSections(Array.from({ length: 60 }, () => ({ type: "body", body: "x" })));
    expect(many.length).toBe(40);
  });
});

describe("unsupportedSectionTypes — the custom_html refusal boundary", () => {
  it("names pasted markup and any other undeclared type", () => {
    expect(unsupportedSectionTypes([{ type: "body" }])).toEqual([]);
    expect(unsupportedSectionTypes([{ type: "custom_html" }, { type: "body" }, { type: "raw" }])).toEqual([
      "custom_html",
      "raw"
    ]);
  });

  it("a section write naming custom_html is refused, not carried", () => {
    const draft = normalizeDraft({ subject: "S" });
    const r = applyCommandToDraft(draft, {
      kind: "collection.add",
      path: "sections",
      item: { type: "custom_html", html: "<p>pasted</p>" }
    });
    expect(r.ok).toBe(false);
    expect(r.issues?.[0].code).toBe("unsupported_section");
    // The refusal names the supported set so the caller can re-ask honestly.
    expect(r.issues?.[0].message).toContain("heading");
    expect(r.draft?.sections ?? draft.sections).toEqual([]);
  });
});

describe("draftLocked — the review_state lifecycle", () => {
  it("opens for the declared mutable states and closes for the rest", () => {
    for (const s of OPEN_REVIEW_STATES) expect(draftLocked(s)).toBe(false);
    for (const s of ["scheduled", "sending", "sent", "paused", "cancelled"]) expect(draftLocked(s)).toBe(true);
    // No state yet means the draft is still being shaped — open.
    expect(draftLocked(null)).toBe(false);
    expect(draftLocked(undefined)).toBe(false);
  });

  it("a scheduled campaign refuses mutation even on a mutable path", () => {
    const draft = normalizeDraft({ subject: "S" });
    const r = applyCommandToDraft(
      draft,
      { kind: "state.set", path: "subject", value: "Edited" },
      { reviewState: "scheduled" }
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("state_locked");
  });
});

describe("normalizeDraft", () => {
  it("defaults the audience to all customers and keeps references, never rows", () => {
    const d = normalizeDraft({});
    expect(d.audience_source).toBe("all");
    expect(d.audience_segment).toEqual([]);
    expect(d.audience_accounts).toEqual([]);
  });

  it("carries a segment only when the source is segment", () => {
    const seg = { segment_id: "seg_1", label: "Active" };
    expect(normalizeDraft({ audience_source: "segment", audience_segment: [seg] }).audience_segment).toEqual([seg]);
    // A segment pasted while the source is "all" is dropped, not silently kept.
    expect(normalizeDraft({ audience_source: "all", audience_segment: [seg] }).audience_segment).toEqual([]);
  });

  it("dedupes accounts by id and refuses a malformed email", () => {
    const d = normalizeDraft({
      audience_source: "individual",
      audience_accounts: [
        { account_id: "a1", name: "Ada", email: "ada@test.hk" },
        { account_id: "a1", name: "Dupe", email: "dupe@test.hk" },
        { account_id: "a2", name: "Bad", email: "not-an-email" }
      ]
    });
    expect(d.audience_accounts.length).toBe(2);
    expect(d.audience_accounts.find((a) => a.account_id === "a2")?.email).toBe("");
  });

  it("keeps an ISO scheduled_for and clears a malformed one", () => {
    expect(normalizeDraft({ scheduled_for: "2026-09-20T09:00" }).scheduled_for).toBe("2026-09-20T09:00");
    expect(normalizeDraft({ scheduled_for: "next tuesday" }).scheduled_for).toBe("");
  });
});

describe("audienceKey / draftFingerprint", () => {
  const base = normalizeDraft({
    audience_source: "segment",
    audience_segment: [{ segment_id: "seg_1", label: "Active" }],
    subject: "Hello"
  });

  it("audienceKey changes when the audience changes, not when content does", () => {
    const contentChanged = normalizeDraft({ ...base, subject: "Different subject", preheader: "new" });
    expect(audienceKey(contentChanged)).toBe(audienceKey(base));
    const audienceChanged = normalizeDraft({ ...base, audience_source: "all" });
    expect(audienceKey(audienceChanged)).not.toBe(audienceKey(base));
  });

  it("draftFingerprint changes on any content edit — approval binds the exact draft", () => {
    const edited = normalizeDraft({ ...base, subject: "Edited" });
    expect(draftFingerprint(edited)).not.toBe(draftFingerprint(base));
  });
});

describe("missingForSend", () => {
  it("needs a subject and at least one section", () => {
    expect(missingForSend(normalizeDraft({}))).toEqual(["subject", "sections"]);
    expect(missingForSend(normalizeDraft({ subject: "Hi", sections: [{ type: "body", body: "x" }] }))).toEqual([]);
    expect(missingForSend(normalizeDraft({ subject: "Hi" }))).toEqual(["sections"]);
  });
});

describe("applyCommandToDraft — the mutable allowlist", () => {
  const draft = normalizeDraft({ subject: "Original", audience_source: "all" });

  it("writes a mutable field with state.set", () => {
    const r = applyCommandToDraft(draft, { kind: "state.set", path: "subject", value: "New subject" });
    expect(r.ok).toBe(true);
    expect(r.draft?.subject).toBe("New subject");
  });

  it("refuses to write an outcome-owned field", () => {
    for (const path of ["review_state", "estimate", "delivery_stats", "favcrm_campaign_id"]) {
      const r = applyCommandToDraft(draft, { kind: "state.set", path, value: "x" });
      expect(r.ok, path).toBe(false);
      expect(r.issues?.[0].code).toBe("not_mutable");
    }
    expect(OUTCOME_PATHS).toContain("review_state");
  });

  it("refuses a field outside the allowlist entirely", () => {
    const r = applyCommandToDraft(draft, { kind: "state.set", path: "internal_notes", value: "x" });
    expect(r.ok).toBe(false);
    expect(r.issues?.[0].code).toBe("not_mutable");
  });

  it("collection.add appends a normalized section", () => {
    const r = applyCommandToDraft(draft, {
      kind: "collection.add",
      path: "sections",
      item: { type: "cta", cta_label: "Go", cta_url: "https://x.test" }
    });
    expect(r.ok).toBe(true);
    expect(r.draft?.sections.at(-1)).toMatchObject({ type: "cta", cta_label: "Go" });
  });

  it("collection.update patches a row by id", () => {
    const seeded = normalizeDraft({ sections: [{ type: "heading", heading: "Old", id: "s_fix" }] });
    const r = applyCommandToDraft(seeded, {
      kind: "collection.update",
      path: "sections",
      itemId: "s_fix",
      value: { heading: "Renamed" }
    });
    expect(r.ok).toBe(true);
    expect(r.draft?.sections[0].heading).toBe("Renamed");
  });

  it("collection.remove drops a row by id", () => {
    const seeded = normalizeDraft({
      audience_source: "individual",
      audience_accounts: [{ account_id: "a1" }, { account_id: "a2" }]
    });
    const r = applyCommandToDraft(seeded, { kind: "collection.remove", path: "audience_accounts", itemId: "a1" });
    expect(r.draft?.audience_accounts.map((a) => a.account_id)).toEqual(["a2"]);
  });

  it("a stale expectedRevision is a revision_conflict value, not an exception", () => {
    const r = applyCommandToDraft(draft, { kind: "state.set", path: "subject", value: "x" }, { expectedRevision: 1, revision: 3 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("revision_conflict");
  });

  it("a command kind the draft surface does not own is unsupported", () => {
    const r = applyCommandToDraft(draft, { kind: "selection.set", value: {} });
    expect(r.ok).toBe(false);
    expect(r.issues?.[0].code).toBe("unsupported_command");
  });
});

describe("draftToState / sectionsToHtml", () => {
  it("emits only the mutable fields state_json carries — never outcome rows", () => {
    const state = draftToState(normalizeDraft({ subject: "S", sections: [{ type: "body", body: "b" }] }));
    expect(state).toHaveProperty("subject", "S");
    expect(state).toHaveProperty("sections");
    expect(state).not.toHaveProperty("review_state");
    expect(state).not.toHaveProperty("estimate");
  });

  it("renders every declared section type and nothing else", () => {
    const html = sectionsToHtml([
      { type: "heading", heading: "Title" },
      { type: "body", body: "Line one\nLine two" },
      { type: "cta", cta_label: "Go", cta_url: "https://x.test" },
      { type: "image", image_url: "https://cdn.test/a.png" }
    ]);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("Line one<br>Line two");
    expect(html).toContain("https://x.test");
    expect(html).toContain("cdn.test/a.png");
    // An unlisted type — custom_html or anything else — contributes nothing.
    expect(sectionsToHtml([{ type: "custom_html", html: "<p>pasted</p>" }])).toBe("");
  });
});
