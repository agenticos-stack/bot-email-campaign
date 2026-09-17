import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";

/**
 * `refreshGrants` re-reads which of the declared doors the platform has bound
 * into `env` and persists the snapshot the door strip renders. The grant is
 * the platform's to make — the facet only ever *reports* presence — so the
 * test pins that a door granted after the composer first opened is picked up
 * on the next check, and that the two interim doors report their gap honestly
 * rather than pretending to be granted.
 */

type Sqlite = {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  close(): void;
};

const databases: Sqlite[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function sqliteContext() {
  const { DatabaseSync } = (
    process as unknown as { getBuiltinModule(name: string): { DatabaseSync: new (path: string) => Sqlite } }
  ).getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*SELECT\b/i.test(query)) {
        const values = db.prepare(query).all(...bindings);
        return { toArray: () => values, one: () => values[0] };
      }
      // Migrations arrive as one multi-statement string with no bindings —
      // `prepare` runs only the first, so those go through `db.exec`. A write
      // always carries bindings and is a single prepared statement.
      if (bindings.length === 0) db.exec(query);
      else db.prepare(query).run(...bindings);
      return { toArray: () => [], one: () => undefined };
    }
  };
  return {
    ctx: {
      storage: {
        sql,
        transactionSync<T>(callback: () => T): T {
          db.exec("BEGIN");
          try {
            const result = callback();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
      }
    }
  };
}

function gadgetWithEnv(env: Record<string, unknown>) {
  const { ctx } = sqliteContext();
  return new Gadget(ctx as never, env as never);
}

describe("getCapabilities / refreshGrants", () => {
  it("with no doors bound, reports every declared door as not granted — never as an error", async () => {
    const gadget = gadgetWithEnv({});
    const result = await gadget.refreshGrants();
    expect(result.ok).toBe(true);
    // All four declared doors present in the report, none granted.
    for (const key of ["favcrm_connector", "email_sender", "schedule", "workspace"]) {
      expect(result.capabilities[key].granted).toBe(false);
    }
  });

  it("marks the two interim doors interim, and the real kinds not", () => {
    const gadget = gadgetWithEnv({});
    const { capabilities } = gadget.getCapabilities();
    expect(capabilities.favcrm_connector.interim).toBe(true);
    expect(capabilities.email_sender.interim).toBe(true);
    expect(capabilities.schedule.interim).toBe(false);
    expect(capabilities.workspace.interim).toBe(false);
  });

  it("picks up a door granted after first open — a grant the composer could not reach before", async () => {
    const env: Record<string, unknown> = {};
    const gadget = gadgetWithEnv(env);

    let caps = gadget.getCapabilities().capabilities;
    expect(caps.schedule.granted).toBe(false);
    expect(caps.workspace.granted).toBe(false);

    // The owner grants scheduling and notifications in the host dialog; env
    // now binds them. A refresh reflects the new grant without disturbing the
    // still-absent interim doors.
    env.schedule = { create: async () => ({}) };
    env.workspace = { notify: async () => ({}) };
    const result = await gadget.refreshGrants();
    expect(result.capabilities.schedule.granted).toBe(true);
    expect(result.capabilities.workspace.granted).toBe(true);
    expect(result.capabilities.favcrm_connector.granted).toBe(false);
    expect(result.capabilities.email_sender.granted).toBe(false);
  });

  it("persists the snapshot to session so a reopen renders without a fresh grant check", async () => {
    const gadget = gadgetWithEnv({ workspace: { notify: async () => ({}) } });
    await gadget.refreshGrants();
    const stored = gadget.storage.getSession("capabilities");
    expect(stored).toMatchObject({ workspace: { granted: true }, favcrm_connector: { granted: false, interim: true } });
    expect(typeof stored.at).toBe("string");
  });
});
