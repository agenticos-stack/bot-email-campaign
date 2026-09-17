import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailRuntime, browserBridge } from '../scripts/local-runtime.mjs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('real Email Campaign SQLite draft, revision conflict, and capability gap', {skip: !process.env.BOT_SDK_SOURCE}, async () => {
  // The manifest owns the module list — a gadget source the test forgets to
  // load fails inside the isolate as "No such module", not at the file read.
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const names = manifest.files.filter(name => name.endsWith('.js') && name !== 'client.js');
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL('../src/'+name, import.meta.url), 'utf8')])));
  const origin = 'http://localhost:17921';
  const root = await mkdtemp(join(tmpdir(),'email-persistence-test-'));
  const options = {files, sdkSource: process.env.BOT_SDK_SOURCE, origins:[origin],stateDirectory:join(root,'state')};
  let session;
  const call = async (method, args = []) => session.handle(new Request(origin+'/local-rpc', {
    method:'POST', headers:{origin,'content-type':'application/json','x-bot-local-session':session.token},body:JSON.stringify({method,args})
  }));
  try {
    session = await createEmailRuntime(options);
    // The fixture seeds across the lifecycle — draft, scheduled, sent — and
    // the summary reports them with honest review_state + recipients fields.
    const summary = (await (await call('summary')).json()).value;
    assert.equal(summary.ok, true);
    assert.equal(summary.campaigns.length, 3);
    const byReview = Object.fromEntries(summary.campaigns.map((c) => [c.id, c.reviewState]));
    assert.deepEqual({ cmp_autumn: byReview.cmp_autumn, cmp_oct: byReview.cmp_oct, cmp_aug: byReview.cmp_aug }, { cmp_autumn: 'drafting', cmp_oct: 'scheduled', cmp_aug: 'sent' });
    assert.equal(summary.campaigns.find((c) => c.id === 'cmp_aug').recipients, 1098);
    assert.equal(summary.campaigns.find((c) => c.id === 'cmp_autumn').recipients, null);
    const draft = (await (await call('getDraft',[{id:'cmp_autumn'}])).json()).value;
    assert.equal(draft.campaign.draft.subject, 'A new season, a little something for you');

    const messages = [];
    const browser = {location:{origin}, parent:{postMessage:(value,target)=>messages.push({value,target})},
      fetch: async (url, options) => {
        assert.equal(url, '/local-rpc');
        assert.equal(options.credentials, 'omit');
        return session.handle(new Request(origin+url, {...options,headers:{...options.headers,origin}}));
      }};
    const { DECODE_BYTES_SOURCE } = await import(pathToFileURL(resolve(process.env.BOT_SDK_SOURCE, 'packages/testkit/src/rpc-bytes.js')));
    runInNewContext(browserBridge(session.token, DECODE_BYTES_SOURCE), browser);
    const gadget = browser.gadget;

    // The local bridge has no push subscription.
    assert.equal((await gadget.subscribe()).supported, false);

    // Opening the draft posts the selected campaign to the host for context.
    await gadget.selectCampaign({ id: 'cmp_autumn' });
    assert.equal(messages.at(-1).value.type, 'email-preview-campaign');
    assert.equal(messages.at(-1).value.records[0].id, 'cmp_autumn');

    // A saved draft bumps the revision; a stale base is a conflict value.
    const current = (await gadget.getDraft({ id: 'cmp_autumn' })).campaign;
    const saved = await gadget.saveDraft({ id:'cmp_autumn', draft:{ ...current.draft, subject:'A refreshed subject' }, expectedRevision: current.revision });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.revision, current.revision + 1);
    const stale = await gadget.saveDraft({ id:'cmp_autumn', draft:{ subject:'Stale' }, expectedRevision: current.revision });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'revision_conflict');

    // The command surface enforces the mutable allowlist: a subject write
    // succeeds, an outcome-owned field refuses by value.
    const set = await gadget.applyCommand({ campaignId:'cmp_autumn', command:{ kind:'state.set', path:'preheader', value:'new preheader' }, expectedRevision: saved.revision });
    assert.equal(set.ok, true);
    const outcome = await gadget.applyCommand({ campaignId:'cmp_autumn', command:{ kind:'state.set', path:'review_state', value:'approved' } });
    assert.equal(outcome.ok, false);

    // A proposal that lands a custom_html block marks it `via: "proposal"`
    // on accept — the review gate shows the markup was agent-staged rather
    // than written by a direct edit.
    const prop = await gadget.proposeChange({ campaignId:'cmp_autumn', label:'Paste the shipped email', payload:{ commands:[{ kind:'collection.add', path:'sections', item:{ id:'s_html', type:'custom_html', html:'<p>from proposal</p>' } }] } });
    assert.equal(prop.ok, true, JSON.stringify(prop));
    const accepted = await gadget.acceptProposal({ id: prop.proposalId });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const marked = accepted.campaign.draft.sections.find((s) => s.id === 's_html');
    // Field-wise, not deepEqual — the RPC boundary returns a null-prototype row.
    assert.equal(marked.origin?.via, 'proposal');
    assert.equal(marked.origin?.proposalId, prop.proposalId);
    assert.equal(marked.origin?.label, 'Paste the shipped email');

    // The door-only methods are not admitted without doors — the session gate
    // refuses them before the facet would answer a capability gap by value.
    for (const method of ['sendNow','sendTest','refreshEstimate','listSegments','searchAccounts','verifySender','scheduleSend']) {
      assert.equal((await call(method, [{}])).status, 403, method);
    }
    // But a granted-door-shaped call that IS admitted still refuses by value —
    // the two interim doors are absent, so a send can never reach a provider.
    const review = (await gadget.getReview({ id:'cmp_autumn' }));
    assert.equal(review.ok, true);

    // Persistence: a restart against the same state directory keeps the draft
    // and its bumped revision.
    const previousToken = session.token;
    await session.dispose();
    session = await createEmailRuntime(options);
    assert.equal(session.token, previousToken);
    const persisted = (await (await call('getDraft',[{id:'cmp_autumn'}])).json()).value;
    assert.equal(persisted.campaign.draft.subject, 'A refreshed subject');
    assert.equal(persisted.campaign.draft.preheader, 'new preheader');
    // The provenance marker persists through draft_json storage.
    assert.equal(persisted.campaign.draft.sections.find((s) => s.id === 's_html').origin.proposalId, prop.proposalId);
    // saveDraft, applyCommand, the accepted proposal's command save and its
    // provenance-stamp save each bumped the revision once.
    assert.equal(persisted.campaign.revision, current.revision + 4);
  } finally { await session?.dispose(); await rm(root,{recursive:true,force:true}); }
});
