// Local renderer of the built artifact. No platform credentials or live doors.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createEmailRuntime, browserBridge } from './local-runtime.mjs';
import { EMAIL_DOOR_METHODS } from './local-rpc-contract.mjs';
import { prepareLocalState } from './local-state.mjs';
import { createConnectedApi } from './connected-api.mjs';
import { EMAIL_CAMPAIGN_DEFINITION } from '../definition.ts';
import { createDevelopmentSessions } from './development-session.mjs';
import { createDoorRuntime } from '@agenticos-dev/bot-devkit/doors';
import { createConnectedAgent, emailMethodNames, sourceDigest } from './connected-agent.mjs';
import { buildClient } from './client.mjs';
import { connectedCanvasBridge } from './connected-canvas.mjs';
import { assertGadgetDevWorkspaceId, assertRemoteApiOrigin } from '@agenticos-dev/bot-devkit/origins';
import { describeExpiry, mintGadgetDevSession, readDeveloperKey } from '@agenticos-dev/bot-devkit/session';

const port = Number(process.env.EMAIL_CAMPAIGN_PREVIEW_PORT || 17920);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose an explicit unprivileged preview port.");
const mode = process.env.EMAIL_CAMPAIGN_PREVIEW_MODE || 'fixture';
const connectedModes = new Set(['connected', 'connected-prod']);
/**
 * Read the gadget's source as the platform will see it.
 *
 * Extracted so a reload rebuilds by exactly the same rule as the first build.
 * A watcher that assembles the archive a second, slightly different way is a
 * watcher that serves code the first path would have rejected.
 */
/**
 * Watch the files `readSourceFiles` reads, and nothing else.
 *
 * `recursive` is used for `src/` because a gadget's sources sit directly in
 * it; a watcher that misses a rename would serve stale code and blame the
 * developer's editor. Failures to watch are reported rather than thrown — a
 * preview that runs without hot reload is far better than one that will not
 * start because a directory is missing.
 */
function watchSource(onChange) {
  const watchers = [];
  for (const target of [new URL('../src/', import.meta.url), new URL('../definition.ts', import.meta.url)]) {
    try {
      watchers.push(watch(fileURLToPath(target), { recursive: target.href.endsWith('/') }, onChange));
    } catch (error) {
      console.warn(`not watching ${target.pathname}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return watchers;
}

async function readSourceFiles() {
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const files={};
  for(const name of manifest.files){
    if(!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name) || Object.hasOwn(files,name))throw new Error('Invalid source file.');
    // manifest.json ships in the archive (its storageSchemaVersion) but lives at the package root, not src/.
    files[name]=name==='client.js'?await buildClient():name==='manifest.json'?await readFile(new URL('../manifest.json',import.meta.url),'utf8'):await readFile(new URL('../src/'+name,import.meta.url),'utf8');
  }
  return files;
}

let archive;
if (connectedModes.has(mode)) {
  archive={files:await readSourceFiles()};
} else {
  const bytes = await readFile(new URL("../dist/email-campaign.gadget", import.meta.url));
  archive = await readBlueprintArchive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const fixture = await readFile(new URL("../test/preview-fixture.js", import.meta.url), "utf8");
const canvasCss = await readFile(new URL('../preview/canvas.css', import.meta.url), 'utf8');
if (!['fixture', 'local-runtime', 'connected', 'connected-prod'].includes(mode)) throw new Error('Unknown preview mode');
const frontendOrigin = process.env.EMAIL_CAMPAIGN_FRONTEND_ORIGIN;
const apiOrigin=process.env.EMAIL_CAMPAIGN_API_ORIGIN || process.env.AGENTICOS_API_ORIGIN;
const remote = mode === 'connected-prod';
// A developer key mints the session here; a token and workspace id pasted from
// a browser remain supported for a one-off. Exactly one of the two, because a
// key silently overriding a pasted pair would connect to a workspace the
// operator did not name.
// `bot-dev dev` mints the session and passes it in the child environment under
// generic names, because a host consumes a session it did not mint and naming
// the variables after this gadget would make every gadget invent its own
// spelling of the same three facts. The EMAIL_CAMPAIGN_* names remain for a
// host started by hand.
const developerKey = remote ? readDeveloperKey(process.env.EMAIL_CAMPAIGN_DEV_KEY) : null;
let devToken = remote
  ? (process.env.AGENTICOS_GADGET_DEV_TOKEN || process.env.EMAIL_CAMPAIGN_DEV_TOKEN || '').trim()
  : '';
let devWorkspaceId = remote
  ? (process.env.AGENTICOS_GADGET_DEV_WORKSPACE_ID || process.env.EMAIL_CAMPAIGN_DEV_WORKSPACE_ID || '').trim()
  : '';
if (remote) {
  assertRemoteApiOrigin(apiOrigin);
  if (developerKey) {
    if (devToken || devWorkspaceId) throw new Error('Set EMAIL_CAMPAIGN_DEV_KEY or EMAIL_CAMPAIGN_DEV_TOKEN/EMAIL_CAMPAIGN_DEV_WORKSPACE_ID, not both.');
    const minted = await mintGadgetDevSession({
      apiOrigin,
      developerKey,
      envVar: 'EMAIL_CAMPAIGN_DEV_KEY',
      gadgetKey: EMAIL_CAMPAIGN_DEFINITION.key,
      title: EMAIL_CAMPAIGN_DEFINITION.title
    });
    devToken = minted.devToken;
    devWorkspaceId = minted.workspaceId;
    // The workspace id is a room the operator can open and archive; the token
    // is a credential and is never printed.
    console.log(`gadget-dev session ${devWorkspaceId} on ${apiOrigin}, valid until ${describeExpiry(minted.expiresAtMs)}`);
  } else if (!devToken) {
    throw new Error('Set EMAIL_CAMPAIGN_DEV_KEY to a personal access token with the gadget_dev.session scope, or EMAIL_CAMPAIGN_DEV_TOKEN to a token already minted.');
  }
  assertGadgetDevWorkspaceId(devWorkspaceId, 'EMAIL_CAMPAIGN_DEV_WORKSPACE_ID');
}
/**
 * Which methods this gadget calls on each door.
 *
 * Read off `src/doors.js` rather than invented: these are exactly the calls
 * the gadget makes, so a door appears in `env` with the surface the source
 * actually uses. The platform decides whether any of them may proceed — this
 * only names them, the way DOOR_SPEC does for an installed gadget.
 */
/**
 * Which methods of each granted door the isolate should see.
 *
 * This is a REQUEST, not a description: `agent.doors` intersects it with what
 * the owner granted, and the isolate's `env` is built from the result. So a
 * method missing here is missing from `env` even when the door is granted and
 * the platform offers it — indistinguishable, from inside the gadget, from a
 * door nobody granted.
 *
 * That is how `fetch_media` was invisible after it shipped: the door said
 * "granted", the platform had the method, and `env.metered_fetch.fetch_media`
 * was still undefined because this list had not been told about it.
 */
function doorMethodsByEnvKey() {
  return EMAIL_DOOR_METHODS;
}

const connectedSourceHash = connectedModes.has(mode) ? sourceDigest(archive.files) : null;
const development=connectedModes.has(mode)?createDevelopmentSessions({appKey:EMAIL_CAMPAIGN_DEFINITION.key,origin:frontendOrigin,
  async authenticate(request){
    if (remote) return {userId:'gadget-dev',orgId:devWorkspaceId,devToken};
    const headers={cookie:request.headers.get('cookie') || '',accept:'application/json'};
    const get=async path=>{const result=await fetch(apiOrigin+path,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});if(!result.ok)throw new Error('Local authentication failed');return result.json();};
    const session=await get('/api/auth/get-session');
    if(!session?.user?.id)return null;
    const shell=await get('/v1/studio/shell');
    return {userId:session.user.id,orgId:shell.data?.activeOrg?.id,cookie:headers.cookie};
  },
  async createRuntime(key, identity){
    const root=new URL('../.bot-local/connected/',import.meta.url);
    await mkdir(root,{recursive:true,mode:0o700});
    /*
     * The agent and the isolate get SIBLING directories, never the same one.
     *
     * The testkit claims its state directory by creating it and writing a
     * `.bot-state` marker, and refuses a directory that already exists without
     * one — that is what stops it adopting a directory it does not own. But
     * the agent is started first (deliberately: the door spec shapes `env` at
     * load), and `createConnectedAgent` does `mkdir(stateDirectory, {
     * recursive: true })` to store its session file. Sharing one path meant
     * the agent always created it first, unmarked, so every connected run
     * failed with "Refusing an unowned or symlinked local state directory" —
     * reported, like every other startup failure here, as a generic 409.
     *
     * A child directory does not help either: `recursive: true` creates the
     * parent on the way down. They have to be siblings.
     */
    const sessionRoot=fileURLToPath(new URL(key,root));
    await mkdir(sessionRoot,{recursive:true,mode:0o700});
    const agentStateDirectory=resolve(sessionRoot,'agent');
    const stateDirectory=resolve(sessionRoot,'runtime');
    const prior=new Map(signals.map(signal=>[signal,new Set(process.listeners(signal))]));
    let local;
    let agent;
    // The agent comes FIRST, and the isolate second, because the door spec
    // shapes `env` at load time and only the platform knows which doors this
    // conversation was actually granted. `callLocal` therefore waits on the
    // isolate rather than capturing it: registration happens immediately, but
    // the platform cannot call the gadget until the runtime it calls exists.
    // Both are reassigned by a reload: the gate is replaced before the old
    // isolate is disposed, so a call that arrives mid-swap queues on the NEW
    // promise instead of reaching a runtime that is going away.
    let readyLocal;
    let localReady = new Promise((resolve) => { readyLocal = resolve; });
    try {
      /*
       * The canvas cannot hear the gadget's own broadcasts in this host: the
       * local runtime has no push subscription. The host sees every change the
       * agent makes through `callLocal`, so it announces them; an open canvas
       * re-reads through the supported API when it hears one. The event names
       * are the vocabulary the canvas's subscriber already reloads on.
       */
      const hostEventListeners=new Set();
      const emitHostEvent=(type)=>{for(const listener of [...hostEventListeners]){try{listener({type});}catch{}}};
      // Map each mutating facet method to the event its listeners re-read on:
      // draft/send churn is `campaign`, suggestion changes are `proposal`, and
      // grant/config churn is `capabilities`. Reads announce nothing.
      const hostEventFor=(method)=>
        ['createCampaign','saveDraft','applyCommand','deleteCampaign','selectCampaign','sendTest','sendNow','scheduleSend','undoSend','refreshEstimate','refreshCampaignStatus'].includes(method)?'campaign'
        :['proposeChange','acceptProposal','rejectProposal'].includes(method)?'proposal'
        :['refreshGrants','verifySender','setConfig'].includes(method)?'capabilities'
        :null;
      agent=await createConnectedAgent({apiOrigin,frontendOrigin,cookie:identity.cookie,devToken:identity.devToken,workspaceId:devWorkspaceId,stateDirectory:agentStateDirectory,title:EMAIL_CAMPAIGN_DEFINITION.title,sourceHash:connectedSourceHash,methods:emailMethodNames(),requirements:EMAIL_CAMPAIGN_DEFINITION.requirements,serverSource:archive.files['server.js'],callLocal:async(method,args)=>{
        await localReady;
        const result=await local.handle(new Request('http://127.0.0.1/local-rpc',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json','x-bot-local-session':local.token},body:JSON.stringify({method,args}),duplex:'half'}));
        const payload=await result.json();
        if(!result.ok||!payload.ok)throw new Error(payload.error?.message||'The local source call failed.');
        const hostEvent=hostEventFor(method);
        if(hostEvent)emitHostEvent(hostEvent);
        return payload.value;
      }});
      // Only granted doors appear, so an ungranted one is absent from `env` —
      // the same absence an installed gadget sees, which is what lets the
      // gadget read a missing door as configuration rather than failure.
      let doors = await agent.doors(doorMethodsByEnvKey());
      // `doors` is null when the owner has granted none, and the testkit rejects a
      // null where it accepts an absence — so a workspace with no doors could not
      // start its runtime at all, and the preview reported that as a generic 409.
      // Absence is the documented, supported state; pass it as one.
      const startRuntime=async(files)=>{
        const before=new Map(signals.map(signal=>[signal,new Set(process.listeners(signal))]));
        try{return await createEmailRuntime({files,origins:[frontendOrigin],stateDirectory,doors:doors ?? undefined,seedFixtures:false});}
        finally{for(const signal of signals)for(const listener of process.listeners(signal))if(!before.get(signal).has(listener)&&['onSignalInt','onSignalTerm'].includes(listener.name))process.removeListener(signal,listener);}
      };
      local=await startRuntime(archive.files);
      readyLocal();

      /**
       * Hot reload: new source becomes the live source without a restart.
       *
       * Three things make this cheap rather than delicate, and each is a
       * property something else already guarantees:
       *
       *  - `registerDevelopmentGadget` is built to be called again. It revokes
       *    the previous binding and mints a fresh `dev:<uuid>` so stale action
       *    arguments cannot resolve to the replacement, which is exactly a
       *    reload's semantics. `agent.reload` uses it, so the socket, the
       *    conversation and the granted doors all survive.
       *  - The isolate's state lives in `stateDirectory`, and the testkit's
       *    `dispose()` releases its lock while leaving the `.bot-state` marker
       *    and the SQLite file in place. So the runtime is swapped and the
       *    gadget's data persists — a reload is not a reset.
       *  - `doors` is resolved once and reused, because a grant is the owner's
       *    and does not change when a file does. Re-asking would make every
       *    save a round trip for an answer nobody changed.
       *
       * What it must NOT do is let a call reach a disposed runtime. `callLocal`
       * awaits `localReady`, so each reload replaces that gate with a fresh
       * unresolved promise BEFORE disposing, and resolves it after the new
       * isolate exists. In-flight callers queue rather than fault.
       */
      let reloading=Promise.resolve();
      let lastHash=connectedSourceHash;
      // `force`: an activation retry restarts the isolate even when the spec
      // reads the same, because "consent saved but the door is missing" is
      // exactly the case where the running env disagrees with the grant list.
      const refreshDoors=async(force=false)=>{
        const next=await agent.doors(doorMethodsByEnvKey());
        if(!force && JSON.stringify(next?.spec ?? {})===JSON.stringify(doors?.spec ?? {}))return;
        const previousDoors=doors;
        await localReady;
        localReady=new Promise(resolve=>{readyLocal=resolve;});
        await local.dispose();
        try { doors=next;local=await startRuntime(archive.files); }
        catch(error){doors=previousDoors;local=await startRuntime(archive.files);throw error;}
        finally{readyLocal();}
      };
      const activateRuntime=async(force,requirementKey)=>{
        reloading=reloading.then(()=>refreshDoors(force),()=>refreshDoors(force));
        try {
          await reloading;
          // A refresh that finishes without throwing only proves the refresh
          // ran — an unchanged, still-empty spec "finishes" the same way a
          // real activation does. Require the requested door to actually be
          // in the running spec before reporting ready (F02a); anything else
          // is `refresh_failed`, the same vocabulary an isolate start failure
          // already uses, so the caller never reads "the refresh completed"
          // as "the door is live".
          if(requirementKey && !doors?.spec?.[requirementKey]){
            return {status:'refresh_failed',message:'The permission is saved, but the running local source does not have this door.'};
          }
          return {status:'ready'};
        }
        catch(error){
          reloading=Promise.resolve();
          return {status:'refresh_failed',message:`The permission is saved, but the local runtime could not start it: ${error instanceof Error?error.message:error}`};
        }
      };
      const reload=async()=>{
        let files;
        try { files=await readSourceFiles(); }
        catch (error) { console.error(`reload skipped, source did not build: ${error instanceof Error?error.message:error}`); return; }
        const nextHash=sourceDigest(files);
        // An editor that saves a file it did not change should cost nothing.
        if(nextHash===lastHash) return;
        const gate=new Promise((resolve)=>{ readyLocal=resolve; });
        const previous=local;
        const previousReady=localReady;
        localReady=gate;
        try {
          await previousReady;            // let in-flight calls finish on the old isolate
          await previous.dispose();       // releases the state lock; data stays
          local=await startRuntime(files);
          await agent.reload({sourceHash:nextHash,methods:emailMethodNames(),requirements:EMAIL_CAMPAIGN_DEFINITION.requirements,serverSource:files['server.js']});
          lastHash=nextHash;
          archive={files};
          console.log(`reloaded ${nextHash.slice(0,12)} — ${Object.keys(files).length} files`);
        } catch (error) {
          console.error(`reload failed: ${error instanceof Error?error.message:error}`);
        } finally { readyLocal(); }
      };
      // Serialised and debounced: two saves in quick succession are one
      // reload, and two reloads never overlap on one state directory.
      let pending;
      const scheduleReload=()=>{
        clearTimeout(pending);
        pending=setTimeout(()=>{ reloading=reloading.then(reload,reload); },150);
      };
      const watchers=watchSource(scheduleReload);
      if (doors) console.log(`doors reachable from local source: ${Object.keys(doors.spec).join(', ')}`);
      // `local` is read through a getter: a reload replaces the binding, and a
      // holder of this object must reach the CURRENT isolate, not the one that
      // existed when it was handed over.
      return {
        get token(){ return local.token; },
        handle:async(request)=>{
          const input=await request.clone().json();
          if(input.method==='refreshGrants') {
            reloading=reloading.then(refreshDoors,refreshDoors);
            await reloading;
          }
          await localReady;
          return local.handle(request);
        },
        /*
         * The owner said yes in the host dialog. Record it on the platform,
         * then swap the isolate onto the new door spec the same way
         * `refreshGrants` does, so the canvas the host reloads next sees the
         * door in `env`. A grant that landed but could not be loaded says so,
         * rather than reading as a refusal.
         */
        /*
         * The owner's view of connector families, and their choice of an
         * existing account for one. A grant swaps the isolate onto the new
         * door spec, like a door grant, so `env.<ACCOUNT>` exists before the
         * canvas asks for new connections.
         */
        connections:async(input)=>{
          if(input.operation==='list')return {families:await agent.connectionChoices()};
          const granted=await agent.grantConnection(input);
          reloading=reloading.then(refreshDoors,refreshDoors);
          try { await reloading; }
          catch(error){
            reloading=Promise.resolve();
            throw new Error(`The account was connected, but the local runtime could not load it: ${error instanceof Error?error.message:error}`);
          }
          return {granted};
        },
        /*
         * Consent and activation are separate answers. A grant that saved but
         * could not start in the running isolate returns `refresh_failed` (the
         * API's own `GrantRuntimeRefresh` vocabulary) instead of throwing, so
         * the host can tell the canvas to retry activation rather than ask for
         * consent the owner already gave.
         */
        ...createDoorRuntime({agent,activateRuntime}),
        /*
         * Start a door this conversation ALREADY holds. Grants nothing: a key
         * the platform does not list as granted is refused before any restart.
         */
        agent:{
          get info(){return agent.info;},
          // The agent's operations are the session's own — run, pending, answer,
          // history. The gadget's registered id for this turn is whatever the
          // platform last handed back; the facet instructions carry the "call
          // the current registration only" rule.
          handle:(input,credential)=>agent.handle(input,credential)
        },
        /** Host-observed changes, for the connected canvas's live updates. Returns an unsubscribe. */
        events(listener){hostEventListeners.add(listener);return ()=>hostEventListeners.delete(listener);},
        dispose:async()=>{
          hostEventListeners.clear();
          for (const watcher of watchers) watcher.close();
          clearTimeout(pending);
          await reloading;
          agent.close();
          await local.dispose();
        }
      };
    }
    catch (error) { agent?.close();await local?.dispose().catch(() => undefined); throw error; }
    finally{for(const signal of signals)for(const listener of process.listeners(signal))if(!prior.get(signal).has(listener)&&['onSignalInt','onSignalTerm'].includes(listener.name))process.removeListener(signal,listener);}
  }
}):null;
const connected = connectedModes.has(mode) ? createConnectedApi({apiOrigin, frontendOrigin, development, platform: remote ? 'remote' : 'local'}) : null;
const tokensCss = await readFile(fileURLToPath(import.meta.resolve('@agenticos-dev/bot-shell/tokens.css')), 'utf8');
/*
 * The decoder for the host's binary envelope, from the SAME testkit that
 * encodes it. A source encoder paired with an installed decoder is two wire
 * formats that agree until one of them moves.
 *
 * Only the modes that actually run a local gadget have a host to decode
 * from — the fixture has no RPC at all.
 */
const { DECODE_BYTES_SOURCE, ENCODE_BYTES_SOURCE } = await import('@agenticos-dev/bot-testkit/rpc-bytes');
// Same pinned families as Studio. Embedded locally; no third-party font requests.
const fontFaces = await Promise.all([
  ['geist', 'Geist Variable', '100 900'],
  ['plus-jakarta-sans', 'Plus Jakarta Sans Variable', '200 800']
].map(async ([name, family, weight]) => {
  const bytes = await readFile(fileURLToPath(import.meta.resolve(`@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`)));
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`;
}));
const brandCss = fontFaces.join('\n') + `\n@font-face{font-family:"CJK Sans Fallback";src:local("PingFang HK"),local("PingFang TC"),local("Noto Sans CJK HK"),local("Noto Sans HK"),local("Microsoft JhengHei"),local("Hiragino Sans CNS");size-adjust:100%}`;
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../preview/main.js', import.meta.url))], bundle: true,
  write: false, format: 'esm', platform: 'browser', conditions: ['browser', 'svelte'],
  plugins: [{ name: 'svelte', setup(builder) { builder.onLoad({ filter: /\.svelte$/ }, async ({path}) => ({
    contents: compile(await readFile(path, 'utf8'), { filename: path, generate: 'client', css: 'injected' }).js.code,
    loader: 'js', resolveDir: fileURLToPath(new URL('../preview/', import.meta.url))
  })); } }]
});
const signals = ['SIGINT', 'SIGTERM'];
const priorSignalListeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
// The testkit admits only HTTP loopback origins, so the local runtime is
// reached on its own port — the gateway host is for the connected modes, where
// the API, not this adapter, owns origin checks.
const runtime = mode === 'local-runtime' ? await createEmailRuntime({ files: archive.files,
  stateDirectory: await prepareLocalState(),
  origins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] }) : null;
// Pinned Miniflare 4.20260702.0 installs immediate process.exit signal hooks.
// This foreground HTTP host owns graceful shutdown instead. Remove only the
// known hooks installed by this runtime, never pre-existing process listeners.
if (runtime) for (const signal of signals) for (const listener of process.listeners(signal)) {
  if (!priorSignalListeners.get(signal).has(listener) && ['onSignalInt', 'onSignalTerm'].includes(listener.name))
    process.removeListener(signal, listener);
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const nonce = randomBytes(16).toString("base64");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  if(connected && url.pathname==='/dev-canvas' && request.method==='GET'){
    response.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:; img-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`);
    response.setHeader('Content-Type','text/html; charset=utf-8');
    const script=(connectedCanvasBridge(frontendOrigin, DECODE_BYTES_SOURCE, ENCODE_BYTES_SOURCE)+'\n'+archive.files['client.js']).replaceAll('</script','<\\/script');
    response.end(`<!doctype html><html lang="${url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${brandCss}\n${tokensCss}\n${canvasCss}</style></head><body><main id="gadget-root"></main><script nonce="${nonce}">${script}</script></body></html>`);return;
  }
  if (connected && url.pathname.startsWith('/api/')) {
    try {
      if (request.headers.host !== new URL(frontendOrigin).host) { response.writeHead(403).end(); return; }
      // A client that goes away aborts its request, so a live-update stream
      // unsubscribes instead of holding a listener for a closed tab.
      const disconnected = new AbortController();
      response.on('close', () => disconnected.abort());
      const result = await connected(new Request(new URL(request.url, frontendOrigin), {
        method: request.method, headers: request.headers, signal: disconnected.signal,
        ...(!['GET','HEAD'].includes(request.method) ? {body: Readable.toWeb(request), duplex: 'half'} : {})
      }));
      response.statusCode = result.status;
      for (const [key,value] of result.headers) if (key !== 'set-cookie') response.setHeader(key,value);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('Set-Cookie', cookies);
      /*
       * An event stream is piped, never buffered. `await result.text()` waits
       * for the end of a body that by design does not end, so no event — and
       * not even the status line — ever reached the browser, and an open
       * drawer could not hear a delivered image.
       */
      if ((result.headers.get('content-type') || '').startsWith('text/event-stream') && result.body) {
        response.flushHeaders();
        Readable.fromWeb(result.body).on('error', () => response.end()).pipe(response);
        return;
      }
      response.end(await result.text());
    } catch { response.writeHead(502).end(); }
    return;
  }
  if (connected && ['/canvas','/client.js','/fixture.js','/local-rpc'].includes(url.pathname)) { response.writeHead(404).end(); return; }
  if (runtime && url.pathname === '/local-rpc') {
    try {
      /*
       * Host-alias origins: the dev gateway serves this preview under a name
       * (email.localhost:18000) the testkit's loopback allowlist does not
       * admit, so a same-origin canvas POST arrives as Origin:
       * http://email.localhost:18000 and is refused `local_session_required`
       * even though it is exactly the request the session exists to serve.
       *
       * The check the session performs is "is the caller a page this server
       * served" — an Origin whose host is the request's own Host is
       * same-origin-as-served under whatever alias carried it (a cross-origin
       * page always reports an Origin host different from the target's).
       * Normalize that case to the loopback origin the session admitted; the
       * `x-bot-local-session` token check is unchanged either way.
       *
       * `Origin: null` is admitted for the same reason: it names no origin at
       * all — a sandboxed or srcdoc frame is opaque by design, and a genuinely
       * cross-origin page always sends its own origin, never null. An ABSENT
       * Origin is admitted for the same reason again: a browser POST always
       * carries Origin, so its absence means a non-browser client or tooling
       * that strips headers — not a drive-by page (which cannot suppress its
       * own Origin on fetch). A hostile page also cannot mint these cases
       * with our token: `frame-ancestors 'self'` refuses to embed /canvas in
       * a foreign frame, and CORS never exposes fixture.js (where the token
       * lives) cross-origin. What still stands between the caller and the
       * session is the same pair as always: the loopback-only bind and the
       * `x-bot-local-session` token check, which runs after this rewrite and
       * refuses a wrong or absent token.
       */
      const headers = new Headers(request.headers);
      const origin = headers.get('origin');
      if (origin === 'null' || !origin) {
        headers.set('origin', `http://127.0.0.1:${port}`);
      } else {
        try {
          const from = new URL(origin);
          if (from.protocol === 'http:' && from.host === headers.get('host')) headers.set('origin', `http://127.0.0.1:${port}`);
        } catch {}
      }
      // The request body is small (LOCAL_RPC_MAX_BYTES) — read it once so the
      // refusal log below can name the method, then hand the bytes on.
      let rawBody = null;
      if (!['GET','HEAD'].includes(request.method)) {
        const chunks = [];
        for await (const b of request) chunks.push(b);
        rawBody = Buffer.concat(chunks).toString('utf8');
      }
      let rpcMethod = null;
      try { rpcMethod = rawBody ? JSON.parse(rawBody)?.method ?? null : null; } catch {}
      const result = await runtime.handle(new Request('http://127.0.0.1/local-rpc', {
        method: request.method, headers,
        ...(rawBody !== null ? {body: rawBody, duplex: 'half'} : {})
      }));
      const resultText = await result.text();
      // Refusals are invisible in a network panel — they arrive as 200 or as
      // the admission 403 — so name the caller here: which method, from what
      // origin, and whether the session token matched. This is the evidence
      // the console cannot show.
      let refused = !result.ok;
      let refusalError = null;
      try { const parsed = JSON.parse(resultText); if (parsed && parsed.ok === false) { refused = true; refusalError = parsed.error; } else if (!result.ok) refusalError = parsed?.error ?? null; } catch {}
      if (refused) {
        const tokenGiven = headers.get('x-bot-local-session');
        console.warn(`[local-rpc refused] method=${rpcMethod ?? '(unparsed)'} status=${result.status} error=${JSON.stringify(refusalError)} origin=${origin} host=${headers.get('host')} referer=${headers.get('referer')} token=${tokenGiven === runtime.token ? 'match' : tokenGiven ? 'MISMATCH' : 'absent'}`);
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(resultText);
    } catch (err) { console.warn('[local-rpc transport]', err); response.writeHead(500, {'Content-Type':'application/json'}).end('{"error":"local_transport_failed"}'); }
    return;
  }
  response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:; img-src blob: data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${url.pathname === '/canvas' ? "'self'" : "'none'"}`);
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (url.pathname === '/workspace.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === "/client.js" || url.pathname === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(url.pathname === "/client.js" ? archive.files["client.js"] : runtime ? browserBridge(runtime.token, DECODE_BYTES_SOURCE) : fixture);
    return;
  }
  if (!["/", "/canvas"].includes(url.pathname)) { response.writeHead(404).end(); return; }
  const locale = url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "en";
  if (runtime || connected) response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy').replace("connect-src 'none'", "connect-src 'self'"));
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === '/') {
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email Campaign — local workspace</title><style>${brandCss}
${tokensCss}</style></head><body><div id="preview-root" data-mode="${mode}"></div><script nonce="${nonce}" type="module" src="/workspace.js"></script></body></html>`);
    return;
  }
  response.end(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email Campaign canvas — ${mode} preview</title><style>${brandCss}
${tokensCss}\n${canvasCss}</style></head><body><main id="gadget-root"></main><script nonce="${nonce}" src="/fixture.js"></script><script nonce="${nonce}" src="/client.js"></script></body></html>`);
});
server.listen(port, "127.0.0.1", () => console.log(`${mode} preview: http://127.0.0.1:${port}/ (${remote ? 'gadget-dev token against production API; ticketed agent + local SQLite' : connected ? 'local API authentication; ticketed agent + local SQLite' : runtime ? 'SQLite persists in .bot-local/email-campaign' : 'in-memory fixture'})`));
server.on('error', async error => { console.error(error.message); await runtime?.dispose(); process.exitCode = 1; });
let stopping = false;
for (const signal of signals) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    try { await runtime?.dispose(); await development?.dispose(); process.exit(0); }
    catch (error) { console.error('Shutdown failed; local state lock retained.', error.message); process.exit(1); }
  });
});
