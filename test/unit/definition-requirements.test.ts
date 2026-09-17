import { describe, expect, it } from "vitest";
import { EMAIL_CAMPAIGN_DEFINITION } from "../../definition.ts";

/**
 * Draft first: the composer opens with nothing granted, so every requirement
 * the send path needs must be optional here and enforced at the operation
 * (`sendNow`, `refreshEstimate`, `verifySender`), not at setup. A required row
 * would gate the gadget's own list/draft reads behind a grant it cannot reach.
 */
const byKey = Object.fromEntries(
  EMAIL_CAMPAIGN_DEFINITION.requirements.map((requirement) => [requirement.requirementKey, requirement as Record<string, unknown>])
);

describe("Email Campaign requirement declarations", () => {
  it("opens with nothing granted: every requirement is checked by the operation that uses it", () => {
    // The connector, sender, schedule and workspace doors are all consulted by
    // an operation that refuses by value when absent — never by a setup gate.
    for (const key of ["favcrm_connector", "email_sender", "schedule", "workspace"]) {
      expect({ key, optional: byKey[key]?.optional }).toEqual({ key, optional: true });
    }
    expect(
      EMAIL_CAMPAIGN_DEFINITION.requirements.filter((requirement) => !(requirement as { optional?: boolean }).optional)
    ).toEqual([]);
  });

  it("declares the connector as a connector_resource and the rest as capabilities", () => {
    // `favcrm_connector` resolves to a FavCRM account binding; the others are
    // capability kinds the gatekeeper either grants or reports absent.
    expect(byKey.favcrm_connector).toMatchObject({ kind: "connector_resource" });
    expect(byKey.email_sender).toMatchObject({ kind: "capability" });
    expect(byKey.schedule).toMatchObject({ kind: "capability" });
    expect(byKey.workspace).toMatchObject({ kind: "capability" });
  });

  it("declares exactly the four doors the facet reads — no phantom requirements", () => {
    expect(EMAIL_CAMPAIGN_DEFINITION.requirements.map((r) => r.requirementKey).sort()).toEqual([
      "email_sender",
      "favcrm_connector",
      "schedule",
      "workspace"
    ]);
  });
});
