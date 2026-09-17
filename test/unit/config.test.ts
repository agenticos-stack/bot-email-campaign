// Node unit tests for the pure config helpers `server.js` calls.
// No I/O, like model.js's own tests — these are the per-instance knobs a
// settings panel walks; none is a door grant and none carries a credential.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, configIssues, normalizeConfig } from "../../src/config.js";

describe("normalizeConfig", () => {
  it("fills in defaults for an empty input", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig()).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig(null as never)).toEqual(DEFAULT_CONFIG);
  });

  it("defaults the fresh-estimate guard on", () => {
    // An audience change must invalidate the last estimate before send; the
    // owner may switch this off, but it is never off by accident.
    expect(normalizeConfig({}).requireFreshEstimate).toBe(true);
    expect(normalizeConfig({ requireFreshEstimate: false }).requireFreshEstimate).toBe(false);
  });

  it("trims and bounds the sender display name", () => {
    expect(normalizeConfig({ senderDisplayName: "  The Studio Team  " }).senderDisplayName).toBe("The Studio Team");
    const long = normalizeConfig({ senderDisplayName: "x".repeat(400) }).senderDisplayName;
    expect(long.length).toBeLessThanOrEqual(120);
  });

  it("ignores non-string and non-boolean overrides rather than coercing them", () => {
    const out = normalizeConfig({
      senderDisplayName: 42 as never,
      requireFreshEstimate: "yes" as never,
      notifyOnSendOutcome: 1 as never
    });
    expect(out).toEqual(DEFAULT_CONFIG);
  });
});

describe("configIssues", () => {
  it("reports no issues for a valid input", () => {
    expect(configIssues({})).toEqual([]);
    expect(configIssues({ senderDisplayName: "Studio", requireFreshEstimate: true })).toEqual([]);
  });

  it("flags a non-string sender display name", () => {
    const issues = configIssues({ senderDisplayName: 7 as never });
    expect(issues.length).toBe(1);
    expect(issues[0].code).toBe("invalid_config");
    expect(issues[0].severity).toBe("error");
  });
});
