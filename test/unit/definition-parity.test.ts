// Definition parity — the facet cannot import definition.ts inside the flat
// archive (raw .js members only, and `as const` is not runtime-parseable), so
// model.js holds the runtime vocabulary. This test makes the copy loud: the
// day the definition changes, this fails instead of silently drifting — the
// failure mode QA flagged on SECTION_TYPES / OPEN_REVIEW_STATES.
import { describe, expect, it } from "vitest";
import { EMAIL_CAMPAIGN_DEFINITION, EMAIL_CAMPAIGN_SECTION_TYPES } from "../../definition.ts";
import { OPEN_REVIEW_STATES, SECTION_TYPES } from "../../src/model.js";

describe("model.js vocabulary tracks definition.ts", () => {
  it("SECTION_TYPES equals EMAIL_CAMPAIGN_SECTION_TYPES", () => {
    expect([...SECTION_TYPES].sort()).toEqual([...EMAIL_CAMPAIGN_SECTION_TYPES].sort());
  });

  it("OPEN_REVIEW_STATES equals the definition's mutableWhen.in", () => {
    const open = EMAIL_CAMPAIGN_DEFINITION.mutableWhen?.in;
    expect(Array.isArray(open)).toBe(true);
    expect([...OPEN_REVIEW_STATES].sort()).toEqual([...(open as string[])].sort());
  });

  it("every OPEN_REVIEW_STATES entry is a declared review_state option", () => {
    const options = EMAIL_CAMPAIGN_DEFINITION.fields.find((f) => f.key === "review_state")?.options ?? [];
    for (const state of OPEN_REVIEW_STATES) expect(options).toContain(state);
  });
});
