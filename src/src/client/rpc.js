// Email Campaign client — the one file that calls the gadget's server.
//
// Every RPC this UI makes goes through here, so a contract change on the
// server side touches this one file rather than every view module that
// happens to need a draft. Each export is a thin pass-through to
// `globalThis.gadget.<method>` — nothing here decides anything; that is the
// facet's job on the data this returns.

/** Wraps the sandbox's `globalThis.gadget` stub — the capnweb RpcStub the host handshake produced. */
export function createRpc(gadget) {
  if (!gadget) throw new Error("createRpc requires the sandboxed gadget stub.");
  return {
    summary: () => gadget.summary(),
    getCapabilities: () => gadget.getCapabilities(),
    refreshGrants: () => gadget.refreshGrants(),
    setConfig: (input) => gadget.setConfig(input),

    listCampaigns: () => gadget.listCampaigns(),
    getCampaign: (id) => gadget.getCampaign(id),
    getDraft: (input) => gadget.getDraft(input),
    getReview: (input) => gadget.getReview(input),
    exportDraft: (input) => gadget.exportDraft(input),
    previewHtml: (input) => gadget.previewHtml(input),

    createCampaign: (input) => gadget.createCampaign(input),
    applyCommand: (input) => gadget.applyCommand(input),
    saveDraft: (input) => gadget.saveDraft(input),
    selectCampaign: (input) => gadget.selectCampaign(input),
    deleteCampaign: (input) => gadget.deleteCampaign(input),

    listProposals: (input) => gadget.listProposals(input),
    proposeChange: (input) => gadget.proposeChange(input),
    acceptProposal: (input) => gadget.acceptProposal(input),
    rejectProposal: (input) => gadget.rejectProposal(input),

    getSenderStatus: () => gadget.getSenderStatus(),
    listSegments: () => gadget.listSegments(),
    searchAccounts: (input) => gadget.searchAccounts(input),
    getSchedules: () => gadget.getSchedules(),

    refreshEstimate: (input) => gadget.refreshEstimate(input),
    sendTest: (input) => gadget.sendTest(input),
    sendNow: (input) => gadget.sendNow(input),
    scheduleSend: (input) => gadget.scheduleSend(input),
    undoSend: (input) => gadget.undoSend(input),
    refreshCampaignStatus: (input) => gadget.refreshCampaignStatus(input),
    verifySender: (input) => gadget.verifySender(input),

    subscribe: (target, client) => gadget.subscribe(target, client)
  };
}
