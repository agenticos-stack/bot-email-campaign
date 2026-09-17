// Node tests for the Email Campaign client. The pure parts (i18n.js, dom.js's
// escaping, state.js's derived flags) are plain-object logic and are tested
// directly; the bundled client.js is smoke-loaded into a hand-rolled DOM (see
// test/unit/_helpers/minimal-dom.ts — neither jsdom, happy-dom nor linkedom is
// a dependency anywhere in this workspace) with a fake `globalThis.gadget`,
// the same way the sandboxed iframe hands the bundle a capnweb stub.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildClient } from "../../scripts/client.mjs";
import { installMinimalDom, flushAsyncWork } from "./_helpers/minimal-dom.ts";
import { button, esc } from "../../src/src/client/dom.js";
import { getLocale, setLocale, t } from "../../src/src/client/i18n.js";
import { S, dirty, estimateStale, loadCampaigns, missing, readOnly, sourceLabel, statusClass } from "../../src/src/client/state.js";
import { normalizeDraft } from "../../src/model.js";

beforeEach(() => {
  // Reset the shared store + locale between tests — they are module singletons.
  setLocale("en");
  S.campaign = null;
  S.edit = null;
  S.op = null;
  S.readOnly = false;
  S.busy = "";
  S.capabilities = {};
  S.view = "list";
});

describe("esc — the render boundary", () => {
  it("escapes every markup metacharacter a draft field could carry", () => {
    expect(esc(`<img src=x onerror=alert(1)>"'`)).toBe("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;");
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

describe("i18n", () => {
  it("picks English or written zh-HK by the active locale", () => {
    setLocale("en");
    expect(t("Save draft", "儲存草稿")).toBe("Save draft");
    setLocale("zh-HK");
    expect(t("Save draft", "儲存草稿")).toBe("儲存草稿");
    expect(getLocale()).toBe("zh");
  });

  it("carries no spoken Cantonese particle — product copy is written zh-HK", () => {
    // The zh strings are the second arg to `t()` across the client sources.
    // Scan those files' string literals — not the header comments that name
    // the banned particles as documentation. Strip line and block comments.
    const files = ["i18n.js", "views.js", "actions.js", "state.js"];
    for (const file of files) {
      const path = fileURLToPath(new URL(`../../src/src/client/${file}`, import.meta.url));
      const source = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const particle of ["嘅", "咗", "唔", "呢個", "邊個", "幾多", "睇", "喺", "嗰"]) {
        expect(source.includes(particle), `${file} copy contains spoken particle ${particle}`).toBe(false);
      }
    }
  });
});

describe("button — stable-label rendering", () => {
  it("marks the governed actions whose label must not reflow on busy", () => {
    const save = button("save", "Save draft");
    expect(save).toContain('data-action="save"');
    expect(save).toContain("busy-label");
    const plain = button("filter", "Drafts");
    expect(plain).not.toContain("busy-label");
  });
});

describe("state derived flags", () => {
  const saved = normalizeDraft({ subject: "Hi", sections: [{ type: "body", body: "x" }] });

  it("dirty() reports a working copy that diverged from the stored draft", () => {
    S.campaign = { draft: saved, revision: 2 };
    S.edit = normalizeDraft({ ...saved });
    expect(dirty()).toBe(false);
    S.edit.subject = "Changed";
    expect(dirty()).toBe(true);
  });

  it("missing() delegates to the send checklist on the working copy", () => {
    S.edit = normalizeDraft({});
    expect(missing()).toEqual(["subject", "sections"]);
    S.edit = normalizeDraft({ subject: "Hi", sections: [{ type: "body", body: "x" }] });
    expect(missing()).toEqual([]);
  });

  it("estimateStale() is true until the stored estimate key matches the working audience", () => {
    S.edit = normalizeDraft({ audience_source: "segment", audience_segment: [{ segment_id: "s1" }] });
    S.campaign = { draft: saved, estimateKey: "" };
    expect(estimateStale()).toBe(true);
  });

  it("statusLabel/statusClass surface an uncertain send as attention, not sent", () => {
    const c = { status: "sent" };
    S.op = { status: "unknown" };
    expect(statusClass(c)).toBe("attention");
    S.op = null;
    expect(statusClass({ status: "queued" })).toBe("buffered");
  });

  it("readOnly() blocks editing a sent or upstream-only campaign", () => {
    S.view = "editor";
    S.campaign = { status: "sent", draft: saved };
    expect(readOnly()).toBe(true);
    S.campaign = { status: "draft", upstreamOnly: true, draft: saved };
    expect(readOnly()).toBe(true);
    S.campaign = { status: "draft", draft: saved };
    expect(readOnly()).toBe(false);
  });

  it("sourceLabel() names the audience the fingerprint row shows", () => {
    expect(sourceLabel(normalizeDraft({ audience_source: "all" }))).toBe("All customers");
    expect(sourceLabel(normalizeDraft({ audience_source: "segment", audience_segment: [{ segment_id: "s", label: "Active" }] }))).toBe("Active");
  });
});

describe("first-run view resolution — auto → setup | list", () => {
  const rpc = (over) => ({
    listCampaigns: async () => ({
      ok: true,
      drafts: [],
      siblings: [],
      history: { campaigns: [] },
      capabilities: {},
      ...over
    })
  });

  it("lands on setup when nothing exists and nothing is granted", async () => {
    S.view = "auto";
    await loadCampaigns(
      rpc({
        capabilities: {
          favcrm_connector: { granted: false, interim: true },
          email_sender: { granted: false, interim: true },
          schedule: { granted: false },
          workspace: { granted: false }
        }
      })
    );
    expect(S.view).toBe("setup");
  });

  it("lands on the list when a draft exists, even with nothing granted", async () => {
    S.view = "auto";
    await loadCampaigns(rpc({ drafts: [{ id: "c1", title: "x", draft: normalizeDraft({}), revision: 1, status: "draft" }] }));
    expect(S.view).toBe("list");
  });

  it("lands on the list when a door is granted, even with nothing to show", async () => {
    S.view = "auto";
    await loadCampaigns(rpc({ capabilities: { workspace: { granted: true } } }));
    expect(S.view).toBe("list");
  });

  it("resolves once — a live-event reload never re-routes a chosen view", async () => {
    S.view = "list"; // the owner already entered the workspace
    await loadCampaigns(rpc({}));
    expect(S.view).toBe("list");
  });
});

describe("bundled client.js — smoke load", () => {
  it("mounts #gadget-root, renders the campaign list and the door strip", async () => {
    const { document, gadgetRoot } = installMinimalDom();
    // The sandbox hands the bundle a capnweb stub; here it is a plain object
    // answering the reads init performs. Sends are never called on load.
    (globalThis as Record<string, unknown>).gadget = {
      getCapabilities: async () => ({
        ok: true,
        capabilities: {
          favcrm_connector: { granted: false, interim: true },
          email_sender: { granted: false, interim: true },
          schedule: { granted: false, interim: false },
          workspace: { granted: true, interim: false }
        },
        grants: {}
      }),
      getSenderStatus: async () => ({ ok: true, sender: null }),
      listCampaigns: async () => ({
        ok: true,
        drafts: [
          { id: "cmp_1", title: "September members’ edit", draft: normalizeDraft({ subject: "A new season" }), revision: 3, status: "draft", updatedAt: "2026-09-16T09:42:00.000Z" }
        ],
        siblings: [],
        history: { campaigns: [] },
        capabilities: {}
      }),
      subscribe: async () => ({ ok: true })
    };
    (globalThis as Record<string, unknown>).location = { search: "?lang=en", href: "http://localhost/?lang=en" };

    const source = await buildClient();
    // The bundle is ESM; evaluating it in this context mounts App().
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    await flushAsyncWork();

    // preserveRender assigns innerHTML; on the shim that is the rendered markup
    // string, so assert on it rather than a parsed childNodes tree.
    const rootText = (gadgetRoot as unknown as { innerHTML?: string }).innerHTML ?? "";
    expect(rootText.length).toBeGreaterThan(0);
    expect(rootText).toContain("door-strip");
    expect(rootText).toContain("September members");
  });
});
