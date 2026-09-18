import {test} from 'node:test';
import {readdir, readFile} from 'node:fs/promises';
import {assertNoSdkRedefinitions} from '@agenticos-dev/bot-devkit/redefinitions';

/*
 * A local declaration that shadows an SDK export is how the forks started:
 * the copy compiles, the import that would have replaced it never happens,
 * and the two drift. The export lists are read from the installed packages —
 * never kept by hand — so a new SDK module joins the guard the day it is
 * adopted. bot-testkit's subpaths join the list when the package lands as a
 * dependency.
 */
const SDK_MODULES = [
  '@agenticos-dev/bot-sdk',
  '@agenticos-dev/bot-devkit',
  '@agenticos-dev/bot-devkit/doors',
  '@agenticos-dev/bot-devkit/host-events',
  '@agenticos-dev/bot-devkit/origins',
  '@agenticos-dev/bot-devkit/redefinitions',
  '@agenticos-dev/bot-devkit/scaffold',
  '@agenticos-dev/bot-devkit/session',
  '@agenticos-dev/bot-shell/client/collection.js',
  '@agenticos-dev/bot-shell/client/dom.js',
  '@agenticos-dev/bot-shell/client/drawer.js',
  '@agenticos-dev/bot-shell/client/elements.js',
  '@agenticos-dev/bot-shell/client/rpc.js',
  '@agenticos-dev/bot-shell/client/steps.js',
  '@agenticos-dev/bot-shell/client/toast.js'
];

const SOURCE_DIRS = ['scripts', 'src'];

async function* sourceFiles(directory) {
  for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), {withFileTypes: true})) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(mjs|js)$/.test(entry.name)) yield path;
  }
}

test('bot source declares no name an SDK package already exports', async () => {
  const sdkExports = new Map();
  for (const mod of SDK_MODULES) {
    for (const name of Object.keys(await import(mod))) {
      if (!sdkExports.has(name)) sdkExports.set(name, mod);
    }
  }
  const files = {};
  for (const dir of SOURCE_DIRS) {
    for await (const path of sourceFiles(dir)) {
      files[path] = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    }
  }
  assertNoSdkRedefinitions({files, sdkExports});
});
