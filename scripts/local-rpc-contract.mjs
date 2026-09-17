// A 2,000,000-byte pasted HTML export plus base64 expansion and its bounded
// metadata. Auth and agent messages retain the smaller limit in the BFF.
export const LOCAL_RPC_MAX_BYTES = 3 * 1024 * 1024;

export const EMAIL_DOOR_METHODS = Object.freeze({
  favcrm_connector: ['listSegments', 'searchAccounts', 'estimate', 'campaignHistory', 'campaignStatus', 'sendTest', 'sendNow', 'scheduleSend', 'undoSend'],
  email_sender: ['status', 'verify'],
  schedule: ['create', 'list', 'cancel'],
  workspace: ['notify', 'listGadgets']
});
