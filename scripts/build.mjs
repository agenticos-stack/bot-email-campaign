import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPackage as buildGadgetPackage,
  assertPackedImports,
  assertStorageSchemaDeclaration
} from "@agenticos-dev/bot-devkit";
import { EMAIL_CAMPAIGN_DEFINITION } from "../definition.ts";
import { buildClient } from "./client.mjs";
import { CURRENT_SCHEMA_VERSION } from "../src/storage.js";

export const packageRoot = new URL("../", import.meta.url);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export { assertPackedImports, assertStorageSchemaDeclaration };

/**
 * Byte budgets, measured against the host's own limits — a regression trips the
 * build, and the only way past one is a deliberate bump here, in the diff.
 *
 * `CLIENT_JS_BYTE_BUDGET` is the gadget-authoring store's per-file read
 * ceiling (api `FILE_RESULT_BYTE_BUDGET`, 156,000 bytes): a client.js read
 * past it comes back without its tail lines, and an `editGadgetFile` composed
 * against that trim writes a canvas that renders blank.
 *
 * `ARCHIVE_BYTE_BUDGET` freezes today's `.gadget` so shared-layer extraction
 * and feature work cannot grow the artifact silently. Bump it only when the
 * growth is the change being reviewed.
 */
export const CLIENT_JS_BYTE_BUDGET = 156_000;
export const ARCHIVE_BYTE_BUDGET = 66_124;

/** Members that are built rather than read from src/: the bundled client and the manifest itself. */
const generatedMembers = {
  "client.js": () => buildClient(),
  "manifest.json": async () => readFile(new URL("manifest.json", packageRoot), "utf8")
};

export async function buildGadget({ outputDir = new URL("dist/", packageRoot), maxBytes = ARCHIVE_BYTE_BUDGET } = {}) {

  return buildGadgetPackage(fileURLToPath(packageRoot), {
    definition: EMAIL_CAMPAIGN_DEFINITION,
    generatedMembers,
    storageSchemaVersion: CURRENT_SCHEMA_VERSION,
    budgets: {
      clientJs: {
        limit: CLIENT_JS_BYTE_BUDGET,
        reason: "the gadget-authoring store's per-file read ceiling (FILE_RESULT_BYTE_BUDGET) — a read past it loses tail lines, and an edit composed against that trim renders blank"
      },
      archive: {
        limit: maxBytes,
        reason: "freezes the .gadget so shared-layer extraction and feature work cannot grow the artifact silently — bump only when the growth is the change being reviewed"
      }
    },
    outputDir: outputDir instanceof URL ? fileURLToPath(outputDir) : outputDir
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { release } = await buildGadget();
  console.log(
    `${release.artifact}: ${release.byteSize} bytes (client.js ${release.clientBytes} bytes), sha256 ${release.sha256}`
  );
}
