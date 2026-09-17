// Email Campaign blueprint — pure instance-config normalization.
//
// Same rule as model.js: no I/O. These are the per-instance knobs a setup
// screen walks — none of them is a door grant (consent is the platform's),
// and none of them carries a credential.

const MAX_LABEL = 120;

function clean(value, max = MAX_LABEL) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  // Display defaults the composer opens with. The verified sender itself is
  // platform-owned (the `email_sender` capability / sender_status outcome) —
  // this is only what the editor shows while no sender is configured.
  senderDisplayName: "",
  // Whether the review step blocks on a fresh audience estimate. Default on:
  // an audience change must invalidate the estimate before send, and this is
  // the switch an owner can flip if they prefer to review without it.
  requireFreshEstimate: true,
  // Workspace notification preference — the `workspace` door is still the
  // authority on whether a notice can post at all.
  notifyOnSendOutcome: true
});

export function normalizeConfig(input = {}) {
  const base = { ...DEFAULT_CONFIG };
  if (!input || typeof input !== "object") return base;
  if (typeof input.senderDisplayName === "string") base.senderDisplayName = clean(input.senderDisplayName);
  if (typeof input.requireFreshEstimate === "boolean") base.requireFreshEstimate = input.requireFreshEstimate;
  if (typeof input.notifyOnSendOutcome === "boolean") base.notifyOnSendOutcome = input.notifyOnSendOutcome;
  return base;
}

export function configIssues(input = {}) {
  const issues = [];
  if (input.senderDisplayName !== undefined && typeof input.senderDisplayName !== "string") {
    issues.push({ code: "invalid_config", severity: "error", message: "senderDisplayName must be a string." });
  }
  return issues;
}
