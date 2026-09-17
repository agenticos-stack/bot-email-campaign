import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { assertPackedImports, assertStorageSchemaDeclaration, buildPackage, sha256 } from "../scripts/build.mjs";
import { EMAIL_CAMPAIGN_DEFINITION } from "../definition.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/storage.js";

/*
 * The host refuses to restore code older than the storage it would run against
 * (api design-plans/feature-bundled-gadget-upgrade-1.md DEC-2). It reads the
 * answer from `storageSchemaVersion` in the archive's own manifest.json, so the
 * archive must carry it and it must match the migrations.
 */
test("every archive carries manifest.json declaring the storage schema storage.js migrates to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "email-campaign-schema-test-"));
  try {
    const built = await buildPackage({ outputDir: directory });
    const archive = await readBlueprintArchive(built.bytes.buffer.slice(built.bytes.byteOffset, built.bytes.byteOffset + built.bytes.byteLength));
    assert.ok(Object.hasOwn(archive.files, "manifest.json"), "manifest.json must be an archive member");
    assert.equal(JSON.parse(archive.files["manifest.json"]).storageSchemaVersion, CURRENT_SCHEMA_VERSION);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a declaration that disagrees with storage.js, or is missing, fails the build", () => {
  const files = ["server.js", "manifest.json"];
  assert.equal(assertStorageSchemaDeclaration({ storageSchemaVersion: 7, files }, 7), 7);
  assert.throws(() => assertStorageSchemaDeclaration({ storageSchemaVersion: 6, files }, 7), /declares storageSchemaVersion 6, but storage.js migrates to 7/);
  assert.throws(() => assertStorageSchemaDeclaration({ files }, 7), /must declare storageSchemaVersion/);
  assert.throws(() => assertStorageSchemaDeclaration({ storageSchemaVersion: "7", files }, 7), /must declare storageSchemaVersion/);
  assert.throws(() => assertStorageSchemaDeclaration({ storageSchemaVersion: 7, files: ["server.js"] }, 7), /must ship inside the archive/);
});

test("repeated builds preserve bytes, complete definition, and member checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "email-campaign-build-test-"));
  try {
    const first = await buildPackage({ outputDir: join(directory, "first") });
    const second = await buildPackage({ outputDir: join(directory, "second") });
    assert.deepEqual(first.bytes, second.bytes);
    assert.deepEqual(first.release, second.release);
    assert.equal(first.release.artifact, "email-campaign.gadget");
    assert.equal(first.release.blueprintKey, "email_campaign");
    assert.equal(first.release.sha256, sha256(first.bytes));
    const archive = await readBlueprintArchive(first.bytes.buffer.slice(first.bytes.byteOffset, first.bytes.byteOffset + first.bytes.byteLength));
    // The archive embeds the VALIDATED definition — `validateGadgetDefinition`
    // normalizes bounded fields (a collection's declared maxItems clamps to the
    // contract's 500-item ceiling), so the comparison is against the checked
    // copy, not the authored export. The API's vendored file carries the same
    // declared values and clamps them identically at registration.
    const { validateGadgetDefinition } = await import("@agenticos-dev/bot-contract");
    const checked = validateGadgetDefinition(EMAIL_CAMPAIGN_DEFINITION);
    assert.equal(checked.ok, true);
    assert.deepEqual(archive.metadata.gadgetDefinition, checked.definition);
    assert.equal(archive.metadata.title, "Email Campaign");
    assert.deepEqual(archive.files, first.files);
    for (const [name, content] of Object.entries(archive.files)) assert.equal(first.release.files[name], sha256(content));
    assert.deepEqual(await readFile(join(directory, "first", first.release.artifact)), first.bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a packed module importing an unpacked one fails the build, not the gadget", () => {
  assert.throws(
    () => assertPackedImports({ "server.js": 'import { a } from "./doors.js";\nimport { b } from "./grant-request.js";', "doors.js": "" }),
    /server\.js imports \.\/grant-request\.js/
  );
  assert.throws(() => assertPackedImports({ "server.js": 'const m = await import("./late.js");' }), /late\.js/);
  assert.doesNotThrow(() => assertPackedImports({ "server.js": 'import { a } from "./doors.js";', "doors.js": "", "client.js": 'import x from "./not-packed.js";' }));
});

test("host size limits reject before writing any release files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "email-campaign-limit-test-"));
  try {
    await assert.rejects(buildPackage({ outputDir: directory, maxBytes: 1 }), /host limit/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(buildPackage({ outputDir: directory, maxBytes: 0 }), /positive integer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/*
 * The client's stylesheet ships as a bundled `text` import. A backtick inside
 * a template literal, or a rule the bundler drops, truncates the sheet and the
 * build still succeeds — the page just ships partly unstyled. Assert the last
 * rules in the sheet survive the bundle: cheaper than reading every comment,
 * and it fails on exactly the shape of the bug.
 */
test("the client stylesheet survives the bundler intact", async () => {
  const { buildClient } = await import("../scripts/client.mjs");
  const bundle = await buildClient();
  for (const rule of [
    ".strip",                         // the status strip, early in the sheet
    ".mail-inner",                    // the composer's live preview
    ".choice",                        // radio cards — audience + conflict dialog
    ".section-block",                 // the typed block editor
    "@media (prefers-reduced-motion", // the motion contract
    "@media (max-width: 640px"        // the last rule in the sheet
  ]) {
    assert.ok(bundle.includes(rule), `stylesheet lost ${rule}`);
  }
});
