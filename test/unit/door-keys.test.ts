import { describe, it, expect } from "vitest";
import { FIXED_DOOR_KEYS, INTERIM_DOOR_KEYS } from "../../src/doors.js";
import { EMAIL_DOOR_METHODS } from "../../scripts/local-rpc-contract.mjs";
import { EMAIL_CAMPAIGN_DEFINITION } from "../../definition.ts";

/**
 * A door the gadget reads but never declares is a door the platform is never
 * asked to resolve, and `env.<key>` is then absent no matter what the owner
 * grants. The social blueprint lost `metered_fetch` exactly this way — the
 * code invented a key the definition never named, so the grantable surface and
 * the read surface quietly disagreed. Here the same three surfaces must agree:
 * the door keys the facet reads, the keys the definition declares, and the
 * method map the connected rig offers.
 */
describe("the doors this gadget reads are doors it declares", () => {
  const declared = new Set(EMAIL_CAMPAIGN_DEFINITION.requirements.map((r) => r.requirementKey));

  it("declares every fixed door key", () => {
    for (const key of FIXED_DOOR_KEYS) {
      expect(declared.has(key), `${key} is read but not declared in definition.ts`).toBe(true);
    }
  });

  it("reads no door the definition did not declare", () => {
    for (const key of EMAIL_CAMPAIGN_DEFINITION.requirements.map((r) => r.requirementKey)) {
      expect(FIXED_DOOR_KEYS.includes(key), `${key} is declared but never read`).toBe(true);
    }
  });

  it("marks exactly the two interim doors whose platform kinds have not landed", () => {
    // `favcrm_connector` and `email_sender` are declared-but-absent until a
    // real door kind exists; schedule and workspace are real today.
    expect([...INTERIM_DOOR_KEYS].sort()).toEqual(["email_sender", "favcrm_connector"]);
    for (const key of INTERIM_DOOR_KEYS) expect(FIXED_DOOR_KEYS).toContain(key);
  });

  it("offers only the doors the contract names, each a declared fixed door", () => {
    for (const key of Object.keys(EMAIL_DOOR_METHODS)) {
      expect(FIXED_DOOR_KEYS, `${key} is offered but is not a fixed door`).toContain(key);
    }
    // And every fixed door the rig can wire has a method list to offer.
    for (const key of FIXED_DOOR_KEYS) {
      expect(Array.isArray(EMAIL_DOOR_METHODS[key]), `${key} has no method list in the contract`).toBe(true);
    }
  });
});
