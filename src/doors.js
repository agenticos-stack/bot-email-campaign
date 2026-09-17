// Email Campaign blueprint — every door call in one file.
//
// `server.js` never reads `this.env.<door>` directly; it calls a function
// here. A contract change on any door — the workspace door's `listGadgets`,
// `schedule`'s arm/cancel, or the connector door the FavCRM binding will
// eventually resolve to — touches this one file, not every method that
// happens to use a door.
//
// TOLERANT OF ABSENCE. Every door here may be missing from `env`: a gadget
// the owner has not finished granting, or — for `favcrm_connector` and
// `email_sender` — a door kind this deployment does not yet implement. Every
// function checks for the door and its method before calling it, and reports
// a capability-gap VALUE rather than throwing: `{ refused: { code:
// "capability_unavailable", door, message } }` so a missing FavCRM or sender
// reads as a grantable gap, never an error.
//
// THE SEND BRIDGE IS A DOOR, NOT A FAKE. `favcrm_connector`'s campaign
// methods (`syncDraft`, `sendTest`, `sendNow`, `scheduleSend`, `undoSend`,
// `campaignStatus`, `estimate`, `listSegments`, `searchAccounts`) are the
// contract a real connector door will satisfy when the kind lands — the
// host-side campaigns service stays where it is and the door delegates to
// it, carrying the draft rather than letting the gadget write state_json.
// In `connected` dev mode the rig injects a loopback implementation backed
// by the local API's campaigns routes — the same shape, the real service —
// which is the only place these calls resolve today.

/**
 * This blueprint's fixed capability doors, keyed exactly as the platform
 * binds them (`gatekeeperEnvKey` identity for non-connector kinds). The two
 * interim doors sit first so a capabilities read lists them in the order the
 * setup screen walks.
 */
export const FIXED_DOOR_KEYS = Object.freeze(["favcrm_connector", "email_sender", "schedule", "workspace"]);

/** The door whose absence is a grantable gap rather than a fault. */
export const INTERIM_DOOR_KEYS = Object.freeze(["favcrm_connector", "email_sender"]);

/**
 * Whether each declared door is currently granted — `env.<key>` present —
 * for `getCapabilities()`'s status block. Absence reads as "not granted",
 * never as an error a console.warn alone recorded.
 */
export function doorGrantStatus(env) {
  const status = {};
  const consent = env && typeof env === "object" && env.__consent && typeof env.__consent === "object" ? env.__consent : null;
  for (const key of FIXED_DOOR_KEYS) {
    status[key] = consent ? consent[key] === true : Boolean(env && typeof env === "object" && env[key]);
  }
  return status;
}

/** A missing door's answer — a capability gap, stated as a value. */
function gap(door, message) {
  return { refused: { code: "capability_unavailable", door, message: message ?? `The ${door} capability is not granted to this gadget.` } };
}

export function isDoorRefusal(value) {
  return Boolean(value && typeof value === "object" && value.refused && typeof value.refused === "object");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "Door call failed.");
}

/**
 * Calls one method on a granted door. Absent door → `gap`; absent method on a
 * granted door → `gap` with the method named (a connector door that resolved
 * to the wrong kind — e.g. `favcrm_connector` granted as a Composio binding —
 * still reads as a gap, never as a working send path). Transport failure →
 * `{ refused: { code: "door_failed" } }`, distinguishing "not granted" from
 * "granted and broken".
 */
export async function callDoor(env, key, method, args = []) {
  const door = env && typeof env === "object" ? env[key] : undefined;
  if (!door) return gap(key);
  const fn = typeof door[method] === "function" ? door[method] : null;
  if (!fn) return gap(key, `The ${key} door does not offer ${method} on this deployment.`);
  try {
    const result = await fn.apply(door, args);
    return result && typeof result === "object" ? result : { data: result };
  } catch (error) {
    return { refused: { code: "door_failed", door: key, message: errorMessage(error) } };
  }
}

// --- workspace (real door kind today) --------------------------------------

/**
 * `env.workspace.listGadgets()` → sibling gadget metadata (id, title,
 * definitionKey, status, updatedAt). Read authority — the campaign list's
 * "other drafts in this workspace" row source.
 */
export async function listWorkspaceGadgets(env) {
  return callDoor(env, "workspace", "listGadgets", []);
}

/**
 * `env.workspace.notify({ title, body, href? })` → `{ sent, coalesced }`.
 * `generate` authority — informational, files no external effect.
 */
export async function notifyWorkspace(env, input) {
  return callDoor(env, "workspace", "notify", [input]);
}

// --- schedule (real door kind today) ---------------------------------------

/** `env.schedule.create(...)` → arm a send time for the approved campaign. */
export async function armSchedule(env, input) {
  return callDoor(env, "schedule", "create", [input]);
}

/** `env.schedule.list()` → the schedules this gadget has armed. */
export async function listSchedules(env) {
  return callDoor(env, "schedule", "list", []);
}

/** `env.schedule.cancel(id)` → disarm a scheduled send. */
export async function cancelSchedule(env, scheduleId) {
  return callDoor(env, "schedule", "cancel", [scheduleId]);
}

// --- favcrm_connector (INTERIM — no real door kind yet) ---------------------
//
// Every method below is the contract a FavCRM connector door satisfies when
// its kind lands. Until then, `env.favcrm_connector` is absent and each call
// answers `capability_unavailable` — the capability gap the canvas renders as
// a grant request, never a thrown error. The `connected` dev rig injects a
// loopback implementation of this exact surface backed by the local API's
// campaigns routes, so the journeys exercise the real domain service.

/** Segments and audience sources FavCRM can resolve — references, not rows. */
export async function favcrmListSegments(env) {
  return callDoor(env, "favcrm_connector", "listSegments", []);
}

/** Search customers for the individual-audience picker — references + labels. */
export async function favcrmSearchAccounts(env, { query = "", limit = 25 } = {}) {
  return callDoor(env, "favcrm_connector", "searchAccounts", [{ query, limit }]);
}

/** Eligibility estimate for a draft's audience — the review step's numbers. */
export async function favcrmEstimate(env, { draft }) {
  return callDoor(env, "favcrm_connector", "estimate", [{ draft }]);
}

/** Upstream campaign history FavCRM already delivered — the list's past rows. */
export async function favcrmCampaignHistory(env, { limit = 50 } = {}) {
  return callDoor(env, "favcrm_connector", "campaignHistory", [{ limit }]);
}

/** The outcome mirror — review_state, delivery_stats, sender_status. */
export async function favcrmCampaignStatus(env, { campaignId }) {
  return callDoor(env, "favcrm_connector", "campaignStatus", [{ campaignId }]);
}

/**
 * The send bridge. `sendTest`, `sendNow`, `scheduleSend` and `undoSend` carry
 * the draft the facet holds — the door (when real, or the dev shim) mirrors it
 * into `state_json` and files the governed action, so a send is always of the
 * exact draft the owner approved, never a divergent copy.
 */
export async function favcrmSendTest(env, { campaignId, draft, to, revision, fingerprint }) {
  return callDoor(env, "favcrm_connector", "sendTest", [{ campaignId, draft, to, revision, fingerprint }]);
}

export async function favcrmSendNow(env, { campaignId, draft, revision, fingerprint }) {
  return callDoor(env, "favcrm_connector", "sendNow", [{ campaignId, draft, revision, fingerprint }]);
}

export async function favcrmScheduleSend(env, { campaignId, draft, scheduledFor, revision, fingerprint }) {
  return callDoor(env, "favcrm_connector", "scheduleSend", [{ campaignId, draft, scheduledFor, revision, fingerprint }]);
}

export async function favcrmUndoSend(env, { campaignId }) {
  return callDoor(env, "favcrm_connector", "undoSend", [{ campaignId }]);
}

// --- email_sender (INTERIM — no real door kind yet) -------------------------
//
// The verified sender identity — platform-owned. `status` reads the sender
// snapshot; `verify` files a sender-verification request. Absent → gap.

export async function emailSenderStatus(env) {
  return callDoor(env, "email_sender", "status", []);
}

export async function emailSenderVerify(env, { provider, fromName, fromEmail }) {
  return callDoor(env, "email_sender", "verify", [{ provider, fromName, fromEmail }]);
}
