import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {RpcClient} from './rpc.mjs';

const LIVE = process.env.TERMX_CODEX_REMOTE_LIVE === '1';
const CODEX = process.env.TERMX_CODEX_EXE || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CWD = path.join(ROOT, '.superpowers', 'swarm-proof', 'remote-agent');
const TIMEOUT = Number(process.env.TERMX_CODEX_REMOTE_TIMEOUT_MS || 120_000);

function input(text) { return [{type: 'text', text}]; }
function metadata(thread) {
  return {
    id: thread.id, sessionId: thread.sessionId, cwd: thread.cwd, ephemeral: thread.ephemeral,
    modelProvider: thread.modelProvider, model: thread.model, reasoningEffort: thread.reasoningEffort,
    canAcceptDirectInput: thread.canAcceptDirectInput,
  };
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
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {}
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
  ws.addEventListener('message', event => client.receive(JSON.parse(event.data)));
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
  const childExited = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  const clients = [];
  let durableId;
  let durableArchived = false;
  child.stderr.resume();
  t.after(async () => {
    if (durableId && !durableArchived && clients[0]) {
      try { await clients[0].request('thread/archive', {threadId: durableId}, {timeoutMs: 10_000}); } catch {}
    }
    for (const client of clients) client.close();
    if (!exited) child.kill();
    await Promise.race([
      childExited,
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    assert.equal(exited, true, 'owned app-server did not emit an exit event after handle-scoped termination');
    assert.equal(isAlive(child.pid), false, 'owned app-server PID remained live after exit');
  });
  await waitReady(port, () => exited);

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

  await assert.rejects(clientA.request('turn/steer', {threadId: two.id, expectedTurnId: crypto.randomUUID(), input: input('invalid')}), /active|turn|mismatch|running/i);

  const durable = (await clientA.request('thread/start', {cwd: CWD, ephemeral: false, environments: []})).thread;
  durableId = durable.id;

  const durableQueueId = crypto.randomUUID();
  const changed = clientA.nextEvent(event => event.method === 'thread/queue/changed' && event.params?.threadId === durable.id);
  const idleStarted = clientA.nextEvent(event => event.method === 'turn/started' && event.params?.threadId === durable.id);
  const added = await clientA.request('thread/queue/add', {
    threadId: durable.id, input: input('Reply with exactly: durable-queued-ok'), clientUserMessageId: durableQueueId,
  });
  assert.equal(added.queuedSubmission.clientUserMessageId, durableQueueId);
  await changed;
  const duplicate = await clientA.request('thread/queue/add', {
    threadId: durable.id, input: input('Reply with exactly: durable-queued-ok'), clientUserMessageId: durableQueueId,
  });
  assert.notEqual(duplicate.queuedSubmission.id, added.queuedSubmission.id,
    'duplicate client correlation keys replace the queued submission with a new server ID');
  assert.deepEqual((await clientA.request('thread/queue/list', {threadId: durable.id})).data.map(row => row.id),
    [duplicate.queuedSubmission.id]);
  const automaticallyStartedTurn = (await idleStarted).params.turn;
  const queuedStarted = clientA.nextEvent(event => event.method === 'turn/started' &&
    event.params?.threadId === durable.id && event.params?.turn?.id !== automaticallyStartedTurn.id);
  await completed(clientA, durable.id, automaticallyStartedTurn.id);
  const durableTurn = (await queuedStarted).params.turn;
  await completed(clientA, durable.id, durableTurn.id);
  await assert.rejects(clientA.request('thread/queue/start', {
    threadId: durable.id, queuedSubmissionId: duplicate.queuedSubmission.id,
  }), /queued submission not found/i);
  const rejoined = (await clientB.request('thread/resume', {threadId: durable.id, excludeTurns: true})).thread;
  assert.deepEqual(metadata(rejoined), metadata(durable));
  const readBack = (await clientB.request('thread/read', {threadId: durable.id, includeTurns: true})).thread;
  assert.ok(readBack.turns.some(turn => turn.id === durableTurn.id && turn.status === 'completed'));
  assert.deepEqual(metadata(readBack), metadata(durable));
  await clientB.request('thread/archive', {threadId: durable.id});
  durableArchived = true;

  clientB.close();
  const postDisconnect = await invoke(clientA, two);
  assert.equal(postDisconnect.threadId, two.id);
  assert.equal(postDisconnect.success, true);
  const stillLoaded = (await clientA.request('thread/loaded/list', {})).data;
  assert.ok(stillLoaded.includes(two.id));
});
