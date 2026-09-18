import { createLocalSession } from '@agenticos-dev/bot-testkit/local-session';
import { LOCAL_RPC_MAX_BYTES } from './local-rpc-contract.mjs';

// Development-only wrapper. The packaged server and its storage stay unchanged.
export async function createEmailRuntime({ files, origins, stateDirectory, doors, seedFixtures = true }) {
  const modules = Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith('.js') && name !== 'client.js'));
  modules['app-server.js'] = modules['server.js'];
  modules['server.js'] = `
    import { Gadget as App } from './app-server.js';
    import { normalizeConfig } from './config.js';
    import { normalizeDraft } from './model.js';
    export class Gadget extends App {
      async seedLocal() {
        return this.ctx.storage.transactionSync(() => {
        if (this.storage.listCampaigns().length) return {seeded:0};
        // Synthetic rows across the lifecycle — the composer opens with real
        // drafts to read and the list shows every review_state chip. Nothing
        // here is a recipient list or a send; it is content shape only.
        this.storage.setSession('config', normalizeConfig({}));
        const now = new Date().toISOString();
        const draft = normalizeDraft({
          title: 'September members’ edit',
          audience_source: 'segment',
          audience_segment: [{ segment_id: 'seg_active', label: 'Active members' }],
          audience_exclusions: [{ kind: 'campaign', id: 'pc_1', label: 'September welcome series' }],
          subject: 'A new season, a little something for you',
          preheader: 'Your first look at what is coming this month.',
          sections: [
            { type: 'heading', heading: 'A little more room for what you love.' },
            { type: 'body', body: 'Hello there,\\n\\nA new season is a good reason to make time for yourself. Our September workshops are now open.' },
            { type: 'cta', cta_label: 'Explore September workshops', cta_url: 'https://example.com/workshops' }
          ]
        });
        const c = this.storage.createCampaign({ id: 'cmp_autumn', title: draft.title, draft, now });
        // An approved draft with a send time — the definition's scheduled
        // review_state, surfaced by campaignSummary's effectiveReviewState.
        const scheduled = this.storage.createCampaign({ id: 'cmp_oct', title: 'October workshop launch', draft: normalizeDraft({
          title: 'October workshop launch',
          audience_source: 'all',
          subject: 'October workshops — first look',
          sections: [{ type: 'body', body: 'Synthetic scheduled draft.' }],
          scheduled_for: '2026-10-02T09:00'
        }), now });
        this.storage.updateCampaignOutcome(scheduled.id, {
          status: 'approved',
          outcomeJson: JSON.stringify({ review_state: 'scheduled', approvals: [{ by: 'local-seed', at: now }] }),
          estimateJson: JSON.stringify({ eligible: 1248, total: 1248 }),
          now
        });
        // A completed send — outcome the domain would have written.
        const sent = this.storage.createCampaign({ id: 'cmp_aug', title: 'August member update', draft: normalizeDraft({
          title: 'August member update', subject: 'August member update',
          sections: [{ type: 'body', body: 'Synthetic sent campaign.' }]
        }), now });
        this.storage.updateCampaignOutcome(sent.id, {
          status: 'sent',
          outcomeJson: JSON.stringify({ review_state: 'sent', sent_at: '2026-08-18T09:12:00.000Z', favcrm_campaign_id: 'fx_aug', delivery_stats: { sent: 1098, delivered: 1042, failed: 0, bounced: 3 } }),
          estimateJson: JSON.stringify({ eligible: 1098, total: 1248 }),
          now: '2026-08-18T09:12:00.000Z'
        });
        this.storage.setSession('selectedCampaignId', c.id);
        return {seeded:3};
        });
      }
    }`;
  /**
   * What the browser may call.
   *
   * The first list needs no door: reading the campaign list and drafts,
   * editing a working copy, staging and settling proposals — and the two
   * calls that must work BEFORE any door exists. `refreshGrants` is the
   * capability-discovery mechanism itself (refusing it without doors would
   * make the first grant unreachable), and `getCapabilities`/`getSenderStatus`
   * answer a gap from `env` alone. Drafting, saving and the command surface
   * never touch a door — a campaign you cannot yet send is still a draft you
   * can shape.
   *
   * The second list is admitted ONLY with doors, because each one's whole
   * purpose is a door call: segments and customer search read the connector,
   * the estimate measures through it, and send/schedule/test/undo plus sender
   * verification are the governed actions. Admitting them without doors would
   * move a clear "this capability is not granted" into a confusing failure
   * inside the gadget — the facet still refuses by value, but the session
   * gate says it first.
   *
   * Admission is not authority either way — the platform still decides whether
   * any door call proceeds, and a send is gated there as it is for an
   * installed gadget.
   */
  const browsing = ['summary','getCapabilities','refreshGrants','setConfig','listCampaigns','getCampaign','getDraft','getReview','exportDraft','previewHtml','createCampaign','applyCommand','saveDraft','selectCampaign','deleteCampaign','listProposals','proposeChange','acceptProposal','rejectProposal','getSenderStatus','getSchedules','subscribe'];
  const needsDoors = ['listSegments','searchAccounts','refreshEstimate','sendTest','sendNow','scheduleSend','undoSend','refreshCampaignStatus','verifySender'];
  const connectedDoors = doors ?? undefined;
  if (seedFixtures) console.warn('Email Campaign fixture runtime seeds synthetic lifecycle drafts. No connector, sender or send is live.');
  return createLocalSession({ modules, origins, stateDirectory, doors: connectedDoors,
    maxRequestBytes: LOCAL_RPC_MAX_BYTES,
    seed: seedFixtures ? [{method:'seedLocal',args:[]}] : [],
    allowedMethods: connectedDoors || !seedFixtures ? [...browsing, ...needsDoors] : browsing });
}

/** `decodeBytes` is the testkit's decoder source; see connectedCanvasBridge for why it is passed in. */
export function browserBridge(token, decodeBytes) {
  return `
  ${decodeBytes}
  globalThis.RpcTarget = class {};
  // JSON has no bytes: a Uint8Array would serialise as an index-keyed object
  // (~10x larger, and unreadable to toBytes). Send base64, which the server's
  // byte arguments already accept.
  function __botArgBytes(value) {
    if (value instanceof ArrayBuffer) value = new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }
    if (Array.isArray(value)) return value.map(__botArgBytes);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, __botArgBytes(entry)]));
    return value;
  }
  async function localCall(method, args) {
    const response = await fetch('/local-rpc', {method:'POST',credentials:'omit',headers:{'content-type':'application/json','x-bot-local-session':${JSON.stringify(token)}},body:JSON.stringify({method,args:__botArgBytes(args)})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Local runtime: '+(result.error || 'call failed')+'. Agent, provider, setup and publishing actions are unavailable.');
    return __botDecodeBytes(result.value);
  }
  globalThis.gadget = new Proxy({}, { get(_, method) {
    if (method === 'then') return undefined;
    if (method === 'subscribe') return async () => ({supported:false,reason:'Local runtime has no push subscription. Reload to read changes.'});
    return async (...args) => {
      const value = await localCall(method, args);
      if (method === 'selectCampaign' || method === 'openDraft') {
        // The open campaign is the chat's context. The listing carries only
        // id+title — never a recipient list — so the host sees which draft the
        // owner is shaping, nothing more.
        const listing = await localCall('listCampaigns', []);
        const selected = (listing.drafts ?? []).find(c => c.id === (args[0]?.id ?? value?.campaign?.id));
        parent.postMessage({type:'email-preview-campaign',records:selected ? [{id:selected.id,label:selected.title || selected.id}] : []},location.origin);
      }
      return value;
    };
  }});`;
}
