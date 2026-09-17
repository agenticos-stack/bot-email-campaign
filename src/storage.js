// Email Campaign blueprint — the one seam onto ctx.storage.sql.
//
// `server.js` never writes SQL inline; every read and write goes through a
// function here so the schema lives in one file. `migrate()` is append-only:
// `CURRENT_SCHEMA_VERSION` only ever moves up, and `agenticosBoot`'s
// `agenticosStorageSchemaVersion()` reads the `schema_version` table before
// restoring older code — a code downgrade that would misread storage refuses
// to start instead of corrupting it.
//
// THE DRAFT LIVES HERE (kickoff 6837c). `campaigns` is the canvas's working
// store: every row is one campaign draft the composer edits. The gadget's
// `state_json` is the governed mirror the campaigns domain service reads —
// the host bridge (a door, when the real kinds land; the dev rig's
// connected-mode shim today) copies `draft_json` there before a send, which
// is why `draft_json` is shaped by `model.js`'s `draftToState`.

export const CURRENT_SCHEMA_VERSION = 1;

const MIGRATIONS = [
  // v1 — campaigns, proposals, and the per-instance session store.
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    -- The normalized draft (model.js normalizeDraft). The editable fields —
    -- audience references, subject/preheader, sections, scheduled_for.
    draft_json TEXT NOT NULL,
    -- The draft's own revision, bumped on every saved write. Approvals bind
    -- this, and the client compares it for conflicts — it is NOT the gadget
    -- state_json revision (the bridge owns that counter).
    revision INTEGER NOT NULL DEFAULT 0,
    -- lifecycle: draft | in_review | approved | queued | sent | attention.
    status TEXT NOT NULL DEFAULT 'draft',
    -- The last estimate the bridge returned, plus the audience key it bound
    -- to — an audience edit must invalidate it (estimate_key != audienceKey).
    estimate_json TEXT,
    estimate_key TEXT,
    -- Outcome mirror the bridge last wrote back: review_state, delivery_stats,
    -- sender_status, favcrm_campaign_id. Read for display, never writable
    -- through a command.
    outcome_json TEXT,
    -- The draft content the last approval bound (draftFingerprint at save).
    saved_fingerprint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS campaigns_updated ON campaigns (updated_at DESC);

  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    -- The command batch the assistant proposed, plus a human label and the
    -- draft revision it was staged against. Accepting applies the batch;
    -- rejecting marks it so the canvas stops offering it.
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    base_revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS proposals_campaign ON proposals (campaign_id, state);

  -- Small per-instance session state: the selected campaign, composer step,
  -- capability snapshot timestamps. One row per key, JSON value.
  CREATE TABLE IF NOT EXISTS session_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  `
];

export class Storage {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
  }

  migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    const row = this.sql.exec("SELECT version FROM schema_version WHERE id = 1").toArray()[0];
    let version = row ? Number(row.version) : 0;
    while (version < MIGRATIONS.length) {
      this.sql.exec(MIGRATIONS[version]);
      version += 1;
      this.sql.exec("INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version", version);
    }
  }

  // --- campaigns -----------------------------------------------------------

  listCampaigns() {
    return this.sql
      .exec("SELECT id, title, draft_json, revision, status, estimate_json, estimate_key, outcome_json, saved_fingerprint, created_at, updated_at FROM campaigns ORDER BY updated_at DESC")
      .toArray()
      .map(decodeCampaignRow);
  }

  getCampaign(id) {
    const row = this.sql
      .exec("SELECT id, title, draft_json, revision, status, estimate_json, estimate_key, outcome_json, saved_fingerprint, created_at, updated_at FROM campaigns WHERE id = ?", id)
      .toArray()[0];
    return row ? decodeCampaignRow(row) : null;
  }

  /** Create a new draft row. Returns the decoded campaign. */
  createCampaign({ id, title = "", draft, now }) {
    this.sql.exec(
      "INSERT INTO campaigns (id, title, draft_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, 0, 'draft', ?, ?)",
      id, title, JSON.stringify(draft), now, now
    );
    return this.getCampaign(id);
  }

  /**
   * Compare-and-swap the draft. The `expectedRevision` gate is the only write
   * gate: a stale base refuses rather than overwriting a newer save.
   */
  saveCampaignDraft({ id, title, draft, expectedRevision, now }) {
    const current = this.getCampaign(id);
    if (!current) return { ok: false, code: "not_found", message: "No such campaign draft." };
    if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== current.revision) {
      return { ok: false, code: "revision_conflict", message: `Draft moved past revision ${expectedRevision} — read the current version before writing.` };
    }
    this.sql.exec(
      "UPDATE campaigns SET title = ?, draft_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      title ?? current.title, JSON.stringify(draft), now, id
    );
    return { ok: true, campaign: this.getCampaign(id) };
  }

  /** Touch only lifecycle/outcome fields — never the draft. */
  updateCampaignOutcome(id, { status, estimateJson, estimateKey, outcomeJson, savedFingerprint, now }) {
    this.sql.exec(
      `UPDATE campaigns SET
         status = COALESCE(?, status),
         estimate_json = COALESCE(?, estimate_json),
         estimate_key = COALESCE(?, estimate_key),
         outcome_json = COALESCE(?, outcome_json),
         saved_fingerprint = COALESCE(?, saved_fingerprint),
         updated_at = ?
       WHERE id = ?`,
      status ?? null, estimateJson ?? null, estimateKey ?? null, outcomeJson ?? null, savedFingerprint ?? null, now, id
    );
  }

  deleteCampaign(id) {
    this.sql.exec("DELETE FROM campaigns WHERE id = ?", id);
  }

  // --- proposals ------------------------------------------------------------

  createProposal({ id, campaignId, kind, payload, label, baseRevision, now }) {
    this.sql.exec(
      "INSERT INTO proposals (id, campaign_id, kind, payload_json, label, base_revision, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      id, campaignId, kind, JSON.stringify(payload), label, baseRevision, now
    );
  }

  getProposal(id) {
    const row = this.sql
      .exec("SELECT id, campaign_id, kind, payload_json, label, base_revision, state, created_at FROM proposals WHERE id = ?", id)
      .toArray()[0];
    return row ? decodeProposalRow(row) : null;
  }

  listProposals(campaignId, state = null) {
    const rows = state
      ? this.sql.exec("SELECT id, campaign_id, kind, payload_json, label, base_revision, state, created_at FROM proposals WHERE campaign_id = ? AND state = ? ORDER BY created_at DESC", campaignId, state).toArray()
      : this.sql.exec("SELECT id, campaign_id, kind, payload_json, label, base_revision, state, created_at FROM proposals WHERE campaign_id = ? ORDER BY created_at DESC", campaignId).toArray();
    return rows.map(decodeProposalRow);
  }

  setProposalState(id, state) {
    this.sql.exec("UPDATE proposals SET state = ? WHERE id = ?", state, id);
  }

  // --- session kv -----------------------------------------------------------

  getSession(key) {
    const row = this.sql.exec("SELECT value_json FROM session_kv WHERE key = ?", key).toArray()[0];
    if (!row) return null;
    try { return JSON.parse(row.value_json); } catch { return null; }
  }

  setSession(key, value) {
    this.sql.exec("INSERT INTO session_kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", key, JSON.stringify(value));
  }
}

function decodeJson(text, fallback) {
  if (typeof text !== "string" || !text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function decodeCampaignRow(row) {
  return {
    id: row.id,
    title: row.title,
    draft: decodeJson(row.draft_json, {}),
    revision: row.revision,
    status: row.status,
    estimate: decodeJson(row.estimate_json, null),
    estimateKey: row.estimate_key,
    outcome: decodeJson(row.outcome_json, null),
    savedFingerprint: row.saved_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function decodeProposalRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    kind: row.kind,
    payload: decodeJson(row.payload_json, {}),
    label: row.label,
    baseRevision: row.base_revision,
    state: row.state,
    createdAt: row.created_at
  };
}
