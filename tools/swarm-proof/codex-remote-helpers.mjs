const failedFrameClients = new WeakSet();

function required(object, field) {
  if (!object || typeof object !== 'object' || !Object.hasOwn(object, field)) {
    throw new TypeError(`missing required field: ${field}`);
  }
  return object[field];
}

function invalid(field) { throw new TypeError(`invalid required field: ${field}`); }
function stringArray(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) invalid(field);
  return value;
}

export function receiveWebSocketFrame(client, data) {
  if (failedFrameClients.has(client)) return;
  try {
    if (typeof data !== 'string') throw new TypeError('unexpected frame type');
    client.receive(JSON.parse(data));
  } catch {
    failedFrameClients.add(client);
    client.disconnect(new Error('Malformed WebSocket frame'));
  }
}

export function threadMetadata(thread) {
  const result = {};
  for (const field of ['id', 'sessionId', 'cwd', 'ephemeral', 'modelProvider', 'model', 'reasoningEffort', 'canAcceptDirectInput']) {
    result[field] = required(thread, field);
  }
  if (typeof result.id !== 'string' || typeof result.sessionId !== 'string' || typeof result.cwd !== 'string' ||
      typeof result.ephemeral !== 'boolean' || typeof result.modelProvider !== 'string' ||
      !(result.model === null || typeof result.model === 'string') ||
      !(result.reasoningEffort === null || typeof result.reasoningEffort === 'string') ||
      !(result.canAcceptDirectInput === null || typeof result.canAcceptDirectInput === 'boolean')) {
    throw new TypeError('invalid required field: thread metadata');
  }
  return result;
}

export function effectiveMetadata(response) {
  const result = {};
  for (const field of ['model', 'modelProvider', 'serviceTier', 'cwd', 'runtimeWorkspaceRoots', 'instructionSources',
    'approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'reasoningEffort']) {
    result[field] = required(response, field);
  }
  if (typeof result.model !== 'string') invalid('model');
  if (typeof result.modelProvider !== 'string') invalid('modelProvider');
  if (!(result.serviceTier === null || typeof result.serviceTier === 'string')) invalid('serviceTier');
  if (typeof result.cwd !== 'string') invalid('cwd');
  stringArray(result.runtimeWorkspaceRoots, 'runtimeWorkspaceRoots');
  stringArray(result.instructionSources, 'instructionSources');
  if (!(result.approvalPolicy === 'untrusted' || result.approvalPolicy === 'on-request' || result.approvalPolicy === 'never' ||
      (result.approvalPolicy && typeof result.approvalPolicy === 'object' && result.approvalPolicy.granular && typeof result.approvalPolicy.granular === 'object'))) invalid('approvalPolicy');
  if (!['user', 'auto_review', 'guardian_subagent'].includes(result.approvalsReviewer)) invalid('approvalsReviewer');
  if (!result.sandbox || typeof result.sandbox !== 'object' || !['dangerFullAccess', 'readOnly', 'externalSandbox', 'workspaceWrite'].includes(result.sandbox.type)) invalid('sandbox');
  if (!(result.activePermissionProfile === null || (result.activePermissionProfile && typeof result.activePermissionProfile.id === 'string' &&
      (result.activePermissionProfile.extends === null || typeof result.activePermissionProfile.extends === 'string')))) invalid('activePermissionProfile');
  if (!(result.reasoningEffort === null || typeof result.reasoningEffort === 'string')) invalid('reasoningEffort');
  return result;
}
