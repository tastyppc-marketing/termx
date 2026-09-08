import assert from 'node:assert/strict';
import test from 'node:test';

import {effectiveMetadata, receiveWebSocketFrame, threadMetadata} from './codex-remote-helpers.mjs';
import {RpcClient} from './rpc.mjs';

function responseFixture() {
  return {
    model: 'model', modelProvider: 'provider', serviceTier: null, cwd: 'C:\\synthetic',
    runtimeWorkspaceRoots: ['C:\\synthetic'], instructionSources: [], approvalPolicy: 'never',
    approvalsReviewer: 'user', sandbox: {type: 'dangerFullAccess'},
    activePermissionProfile: {id: ':workspace', extends: null}, reasoningEffort: null,
  };
}

test('malformed text and binary WebSocket frames fail closed without leaking payloads', async () => {
  for (const frame of ['{private malformed', new Uint8Array([1, 2, 3])]) {
    let closes = 0;
    const client = new RpcClient({send() {}, close() { closes += 1; }});
    const pending = client.request('pending', {});
    assert.doesNotThrow(() => receiveWebSocketFrame(client, frame));
    assert.doesNotThrow(() => receiveWebSocketFrame(client, '{second malformed'));
    await assert.rejects(pending, error => error.message === 'Malformed WebSocket frame' && !/private|1,2,3/.test(error.message));
    await assert.rejects(client.request('after-disconnect', {}), /Malformed WebSocket frame/);
    assert.equal(closes, 0, 'frame owner remains responsible for closing its transport');
  }
});

test('valid text WebSocket frames are decoded once for RPC validation', () => {
  const received = [];
  const client = {receive(message) { received.push(message); }, disconnect() { assert.fail('unexpected disconnect'); }};
  receiveWebSocketFrame(client, '{"id":1,"result":{}}');
  assert.deepEqual(received, [{id: 1, result: {}}]);
});

test('effective metadata rejects every absent required response field', () => {
  const required = Object.keys(responseFixture());
  for (const field of required) {
    const fixture = responseFixture();
    delete fixture[field];
    assert.throws(() => effectiveMetadata(fixture), new RegExp(`missing required field: ${field}`));
  }
});

test('effective metadata accepts schema-defined nullable fields and validates shapes', () => {
  assert.deepEqual(effectiveMetadata(responseFixture()), responseFixture());
  for (const [field, value] of [
    ['model', null], ['runtimeWorkspaceRoots', null], ['instructionSources', {}],
    ['approvalPolicy', 'sometimes'], ['approvalsReviewer', 'agent'], ['sandbox', null],
    ['activePermissionProfile', {id: 1, extends: null}], ['reasoningEffort', 2],
  ]) {
    assert.throws(() => effectiveMetadata({...responseFixture(), [field]: value}), new RegExp(`invalid required field: ${field}`));
  }
});

test('thread metadata requires routing identity fields before comparison', () => {
  const thread = {
    id: 'thread', sessionId: 'session', cwd: 'C:\\synthetic', ephemeral: false,
    modelProvider: 'provider', model: 'model', reasoningEffort: null, canAcceptDirectInput: true,
  };
  assert.deepEqual(threadMetadata(thread), thread);
  for (const field of Object.keys(thread)) {
    const incomplete = {...thread};
    delete incomplete[field];
    assert.throws(() => threadMetadata(incomplete), new RegExp(`missing required field: ${field}`));
  }
});
