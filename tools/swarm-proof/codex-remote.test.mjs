import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {effectiveMetadata, receiveWebSocketFrame, threadMetadata} from './codex-remote-helpers.mjs';
import {RpcClient} from './rpc.mjs';

const LIVE = process.env.TERMX_CODEX_REMOTE_LIVE === '1';
const CODEX = process.env.TERMX_CODEX_EXE || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CWD = path.join(ROOT, '.superpowers', 'swarm-proof', 'remote-agent');
const TIMEOUT = Number(process.env.TERMX_CODEX_REMOTE_TIMEOUT_MS || 120_000);

function input(text) { return [{type: 'text', text}]; }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitReady(port, hasExited) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error('app-server exited before readiness');
    const ready = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('app-server readiness timed out');
}

async function connect(url, onRequest) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {once: true});
  });
  const client = new RpcClient({
    timeoutMs: TIMEOUT,
    maxEvents: 4096,
    send(message) { ws.send(JSON.stringify(message)); },
    close() { ws.close(); },
    onRequest,
  });
  ws.addEventListener('message', event => receiveWebSocketFrame(client, event.data));
  ws.addEventListener('close', () => client.disconnect(new Error('WebSocket closed')));
  await client.request('initialize', {
    clientInfo: {name: 'termx_swarm_probe', title: 'TermX isolated proof', version: '0.1.0'},
    capabilities: {experimentalApi: true},
  });
  client.notify('initialized', {});
  return client;
}

async function completed(client, threadId, turnId) {
  return client.nextEvent(event => event.method === 'turn/completed' &&
    event.params?.threadId === threadId && event.params?.turn?.id === turnId, {timeoutMs: TIMEOUT});
}

test('live shared app-server routes dynamic tools by authoritative thread and keeps sibling alive', {skip: !LIVE, timeout: TIMEOUT * 8}, async t => {
  await mkdir(CWD, {recursive: true});
  const port = await unusedPort();
  const url = `ws://127.0.0.1:${port}`;
  const child = spawn(CODEX, ['app-server', '--listen', url], {
    cwd: CWD,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let exited = false;
  let spawnFailed = false;
  let settleChild;
  const childExited = new Promise(resolve => { settleChild = resolve; });
  child.once('error', () => { spawnFailed = true; settleChild(); });
  child.once('exit', () => { exited = true; settleChild(); });
  const clients = [];
  const barriers = new Map();
  const activeTurns = new Map();
  let durableId;
  let durableArchived = false;
  child.stderr.resume();
  t.after(async () => {
    const failures = [];
    try {
      for (const barrier of barriers.values()) barrier.release.resolve();
      for (const [threadId, turnId] of activeTurns) {
        try { await clients[0]?.request('turn/interrupt', {threadId, turnId}, {timeoutMs: 10_000}); }
        catch { failures.push('tracked turn interrupt failed'); }
      }
      if (durableId && !durableArchived && clients[0]) {
        try { await clients[0].request('thread/archive', {threadId: durableId}, {timeoutMs: 10_000}); }
        catch { failures.push('owned durable thread archive failed'); }
      }
    } finally {
      for (const client of clients) client.close();
      child.stderr.destroy();
      if (!exited && Number.isInteger(child.pid)) child.kill();
      let exitTimer;
      await Promise.race([childExited, new Promise(resolve => { exitTimer = setTimeout(resolve, 5000); })]);
      clearTimeout(exitTimer);
    }
    if (!spawnFailed) {
      if (!exited) failures.push('owned app-server exit event not observed');
      if (Number.isInteger(child.pid) && isAlive(child.pid)) failures.push('owned app-server PID remained live');
    }
    assert.deepEqual(failures, [], `sanitized cleanup failures: ${failures.join(', ')}`);
  });
  await waitReady(port, () => exited || spawnFailed);

  const calls = [];
  const authorized = new Set();
  const handler = async (method, params) => {
    assert.equal(method, 'item/tool/call');
    assert.equal(params.tool, 'peer_signal');
    assert.equal(typeof params.threadId, 'string');
    assert.equal(typeof params.turnId, 'string');
    assert.equal(typeof params.callId, 'string');
    const senderMatches = params.arguments?.senderThreadId === params.threadId;
    const success = authorized.has(params.threadId) && senderMatches;
    calls.push({threadId: params.threadId, turnId: params.turnId, callId: params.callId, senderMatches, success});
    const barrier = barriers.get(params.threadId);
    if (barrier) {
      barrier.reached.resolve(params);
      await barrier.release.promise;
    }
    return {contentItems: [{type: 'inputText', text: success ? 'accepted' : 'rejected'}], success};
  };
  const clientA = await connect(url, handler);
  clients.push(clientA);
  assert.deepEqual((await clientA.request('thread/loaded/list', {})).data, []);

  const tool = {type: 'function', name: 'peer_signal', description: 'Send one synthetic peer signal.', inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {senderThreadId: {type: 'string'}, payload: {type: 'string'}},
    required: ['senderThreadId', 'payload'],
  }};
  const start = () => clientA.request('thread/start', {cwd: CWD, ephemeral: true, environments: [], dynamicTools: [tool]});
  const [{thread: one}, {thread: two}] = await Promise.all([start(), start()]);
  assert.notEqual(one.id, two.id);
  authorized.add(one.id); authorized.add(two.id);
  const loaded = (await clientA.request('thread/loaded/list', {})).data;
  assert.deepEqual(new Set(loaded), new Set([one.id, two.id]));

  const clientB = await connect(url, handler);
  clients.push(clientB);
  assert.deepEqual(new Set((await clientB.request('thread/loaded/list', {})).data), new Set([one.id, two.id]));
  await assert.rejects(
    clientB.request('thread/resume', {threadId: one.id, excludeTurns: true}),
    /no rollout found/i,
    'a second client sees process-loaded ephemeral IDs but cannot resume them as rollouts',
  );
  await assert.rejects(
    clientA.request('thread/resume', {threadId: one.id, excludeTurns: true}),
    /no rollout found/i,
    'even the creating connection cannot apply rollout resume to an ephemeral thread',
  );

  const queueId = crypto.randomUUID();
  await assert.rejects(
    clientA.request('thread/queue/add', {threadId: one.id, input: input('Reply with exactly: queued-ok'), clientUserMessageId: queueId}),
    /ephemeral thread does not support queued submissions/i,
  );
  await assert.rejects(
    clientA.request('thread/queue/start', {threadId: one.id}),
    /ephemeral thread does not support queued submissions/i,
  );

  const invoke = async (client, thread, claimedSender = thread.id) => {
    const before = calls.length;
    const result = await client.request('turn/start', {threadId: thread.id, input: input(
      `Call peer_signal exactly once with senderThreadId ${claimedSender} and payload ping. After its result, reply with one word.`)});
    await completed(client, thread.id, result.turn.id);
    const matching = calls.slice(before).filter(call => call.turnId === result.turn.id);
    assert.equal(matching.length, 1);
    return matching[0];
  };

  const [oneCall, twoCall] = await Promise.all([invoke(clientA, one), invoke(clientA, two)]);
  assert.equal(oneCall.threadId, one.id);
  assert.equal(twoCall.threadId, two.id);
  assert.equal(oneCall.success, true);
  assert.equal(twoCall.success, true);

  const forged = await invoke(clientA, one, two.id);
  assert.equal(forged.threadId, one.id);
  assert.equal(forged.senderMatches, false);
  assert.equal(forged.success, false);

  authorized.delete(one.id);
  const revoked = await invoke(clientA, one);
  assert.equal(revoked.success, false);
  const sibling = await invoke(clientA, two);
  assert.equal(sibling.success, true);

  const durableStart = await clientA.request('thread/start', {
    cwd: CWD, ephemeral: false, environments: [], dynamicTools: [tool],
  });
  const durable = durableStart.thread;
  durableId = durable.id;
  authorized.add(durable.id);

  const hold = {reached: deferred(), release: deferred()};
  barriers.set(durable.id, hold);
  const heldStarted = clientA.nextEvent(event => event.method === 'turn/started' && event.params?.threadId === durable.id);
  const held = await clientA.request('turn/start', {threadId: durable.id, input: input(
    `Call peer_signal exactly once with senderThreadId ${durable.id} and payload hold. After its result, reply with one word.`)});
  assert.equal((await heldStarted).params.turn.id, held.turn.id);
  activeTurns.set(durable.id, held.turn.id);
  const heldCall = await hold.reached.promise;
  assert.equal(heldCall.threadId, durable.id);
  assert.equal(heldCall.turnId, held.turn.id);
  await assert.rejects(
    clientA.request('turn/steer', {
      threadId: durable.id, expectedTurnId: crypto.randomUUID(), input: input('must-not-be-accepted'),
    }),
    error => error.code === -32600 && /expected active turn id .* but found/i.test(error.message),
  );

  const durableQueueId = crypto.randomUUID();
  const changed = clientA.nextEvent(event => event.method === 'thread/queue/changed' && event.params?.threadId === durable.id);
  const added = await clientA.request('thread/queue/add', {
    threadId: durable.id, input: input('Reply with exactly: durable-queued-ok'), clientUserMessageId: durableQueueId,
  });
  assert.equal(added.queuedSubmission.clientUserMessageId, durableQueueId);
  await changed;
  const duplicate = await clientA.request('thread/queue/add', {
    threadId: durable.id, input: input('Reply with exactly: durable-queued-ok'), clientUserMessageId: durableQueueId,
  });
  assert.notEqual(duplicate.queuedSubmission.id, added.queuedSubmission.id,
    'duplicate client correlation keys create distinct server submissions');
  assert.deepEqual((await clientA.request('thread/queue/list', {threadId: durable.id})).data.map(row => row.id),
    [added.queuedSubmission.id, duplicate.queuedSubmission.id]);
  await clientA.request('thread/queue/delete', {
    threadId: durable.id, queuedSubmissionId: duplicate.queuedSubmission.id,
  });
  assert.deepEqual((await clientA.request('thread/queue/list', {threadId: durable.id})).data.map(row => row.id),
    [added.queuedSubmission.id]);
  const queuedStarted = clientA.nextEvent(event => event.method === 'turn/started' && event.params?.threadId === durable.id);
  hold.release.resolve();
  barriers.delete(durable.id);
  await completed(clientA, durable.id, held.turn.id);
  activeTurns.delete(durable.id);
  const durableTurn = (await queuedStarted).params.turn;
  await completed(clientA, durable.id, durableTurn.id);
  assert.deepEqual((await clientA.request('thread/queue/list', {threadId: durable.id})).data, []);

  const idleQueueId = crypto.randomUUID();
  const idleStarted = clientA.nextEvent(event => event.method === 'turn/started' && event.params?.threadId === durable.id);
  const idleAdded = await clientA.request('thread/queue/add', {
    threadId: durable.id, input: input('Reply with exactly: idle-queued-ok'), clientUserMessageId: idleQueueId,
  });
  const idleTurn = (await idleStarted).params.turn;
  await completed(clientA, durable.id, idleTurn.id);
  await assert.rejects(clientA.request('thread/queue/start', {
    threadId: durable.id, queuedSubmissionId: idleAdded.queuedSubmission.id,
  }), /queued submission not found/i);

  const durableResume = await clientB.request('thread/resume', {threadId: durable.id, excludeTurns: true});
  assert.deepEqual(threadMetadata(durableResume.thread), threadMetadata(durable));
  assert.deepEqual(effectiveMetadata(durableResume), effectiveMetadata(durableStart));
  const readBack = (await clientB.request('thread/read', {threadId: durable.id, includeTurns: true})).thread;
  assert.ok(readBack.turns.some(turn => turn.id === durableTurn.id && turn.status === 'completed'));
  assert.deepEqual(threadMetadata(readBack), threadMetadata(durable));
  await clientB.request('thread/archive', {threadId: durable.id});
  durableArchived = true;

  clientB.close();
  const postDisconnect = await invoke(clientA, two);
  assert.equal(postDisconnect.threadId, two.id);
  assert.equal(postDisconnect.success, true);
  const stillLoaded = (await clientA.request('thread/loaded/list', {})).data;
  assert.ok(stillLoaded.includes(two.id));
});
