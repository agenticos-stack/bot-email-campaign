import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { buildPackage } from "../scripts/build.mjs";

test("served preview includes the required mount before loading the real client", { timeout: 10000 }, async () => {
  await buildPackage();
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, EMAIL_CAMPAIGN_PREVIEW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let timer;
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => { throw new Error("Preview exited before listening"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Preview startup timed out")), 5000); })
    ]);
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    const shellHtml = await shell.text();
    assert.match(shellHtml, /id="preview-root"/);
    const response = await fetch(`http://127.0.0.1:${port}/canvas?locale=zh-HK`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<main id="gadget-root"><\/main>/);
    assert.ok(html.indexOf('id="gadget-root"') < html.indexOf('src="/client.js"'));
    assert.match(html, /lang="zh-HK"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/definition.ts`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status, 405);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    await exited;
  }
});

async function fixture(search = "") {
  const context = { URL, location: { href: `http://127.0.0.1:17920/${search}` }, console };
  runInNewContext(await readFile(new URL("preview-fixture.js", import.meta.url), "utf8"), context);
  return context.gadget;
}

test("preview fixture lists campaigns and opens a draft with an estimate", async () => {
  const gadget = await fixture();
  const list = await gadget.listCampaigns();
  assert.equal(list.ok, true);
  assert.equal(list.drafts.length, 3);
  const draft = await gadget.getDraft({ id: "cmp_autumn" });
  assert.equal(draft.ok, true);
  assert.equal(draft.campaign.draft.subject, "A new season, a little something for you");
  assert.equal(draft.campaign.estimate.eligible, 1098);
});

test("preview fixture enforces expectedRevision on save (conflict, not overwrite)", async () => {
  const gadget = await fixture();
  const first = await gadget.saveDraft({ id: "cmp_autumn", draft: { subject: "Local edit" }, expectedRevision: 12 });
  assert.equal(first.ok, true);
  assert.equal(first.revision, 13);
  // A stale base is a conflict value, never an overwrite.
  const stale = await gadget.saveDraft({ id: "cmp_autumn", draft: { subject: "Stale" }, expectedRevision: 12 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "revision_conflict");
});

test("preview fixture answers sends as a capability gap, never a real send", async () => {
  const gadget = await fixture();
  for (const method of ["sendTest", "sendNow", "scheduleSend"]) {
    const res = await gadget[method]({ id: "cmp_autumn" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "capability_unavailable");
    assert.equal(res.door, "favcrm_connector");
  }
});
