import assert from 'node:assert/strict';
import test from 'node:test';

import {RpcClient} from './rpc.mjs';

function fixture(options = {}) {
  const sent = [];
  let closes = 0;
  const client = new RpcClient({
    send(message) { sent.push(message); },
    close() { closes += 1; },
    ...options,
  });
  return {client, sent, closeCount: () => closes};
}

test('reversed responses resolve their matching concurrent requests', async () => {
  const {client, sent} = fixture();
  const first = client.request('first', {});
  const second = client.request('second', {});

  assert.deepEqual(sent, [
    {id: 1, method: 'first', params: {}},
    {id: 2, method: 'second', params: {}},
  ]);
  client.receive({id: 2, result: 'B'});
  client.receive({id: 1, result: 'A'});

  assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
});

test('an RPC error rejects only its matching request', async () => {
  const {client} = fixture();
  const failed = client.request('failed', {});
  const successful = client.request('successful', {});

  client.receive({id: 1, error: {code: 42, message: 'nope', data: {why: 'fixture'}}});
  client.receive({id: 2, result: 'ok'});

  await assert.rejects(failed, error =>
    error.message === 'nope' && error.code === 42 && error.data.why === 'fixture');
  assert.equal(await successful, 'ok');
});

test('disconnect immediately rejects requests and event waits and clears events', async () => {
  const {client} = fixture();
  client.receive({method: 'old', params: 1});
  const request = client.request('work', {});
  const event = client.nextEvent(message => message.method === 'later');

  client.disconnect(new Error('wire lost'));

  await assert.rejects(request, /wire lost/);
  await assert.rejects(event, /wire lost/);
  await assert.rejects(client.nextEvent(() => true), /wire lost/);
});

test('a timed-out request rejects and its late response is ignored', async () => {
  const {client} = fixture();
  const timedOut = client.request('slow', {}, {timeoutMs: 5});
  await assert.rejects(timedOut, /timed out/i);

  assert.doesNotThrow(() => client.receive({id: 1, result: 'late'}));
  const next = client.request('fast', {});
  client.receive({id: 2, result: 'current'});
  assert.equal(await next, 'current');
});

test('an event received before a wait is observed exactly once', async () => {
  const {client} = fixture();
  client.receive({method: 'ready', params: {sequence: 1}});

  assert.deepEqual(await client.nextEvent(event => event.method === 'ready'),
    {method: 'ready', params: {sequence: 1}});
  await assert.rejects(client.nextEvent(event => event.method === 'ready', {timeoutMs: 5}), /timed out/i);
});

test('event storage overflow fails explicitly and closes the channel', async () => {
  const {client, closeCount} = fixture({maxEvents: 1});
  client.receive({method: 'one'});

  assert.doesNotThrow(() => client.receive({method: 'two'}));
  await assert.rejects(client.nextEvent(() => true), /overflow/i);
  assert.equal(closeCount(), 1);
});

test('malformed envelopes fail closed without escaping receive', async () => {
  for (const malformed of [null, [], {}, {id: 1}, {method: ''}, {id: 1, result: 1, error: {message: 'both'}}]) {
    const {client, closeCount} = fixture();
    const pending = client.request('pending', {});
    assert.doesNotThrow(() => client.receive(malformed));
    await assert.rejects(pending, /malformed/i);
    assert.equal(closeCount(), 1);
  }
});

test('server requests produce correlated results and errors', async () => {
  const {client, sent} = fixture({
    async onRequest(method, params) {
      if (method === 'sum') return params.left + params.right;
      const error = new Error('handler failed');
      error.code = 17;
      error.data = {method};
      throw error;
    },
  });

  client.receive({id: 'a', method: 'sum', params: {left: 2, right: 3}});
  client.receive({id: 'b', method: 'explode', params: {}});
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(sent, [
    {id: 'a', result: 5},
    {id: 'b', error: {code: 17, message: 'handler failed', data: {method: 'explode'}}},
  ]);
});

test('a server request without a handler returns method-not-found', async () => {
  const {client, sent} = fixture();
  client.receive({id: 99, method: 'missing', params: {}});
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(sent, [{id: 99, error: {code: -32601, message: 'Method not found'}}]);
});

test('close closes the transport once and rejects outstanding work', async () => {
  const {client, closeCount} = fixture();
  const pending = client.request('pending', {});
  client.close();
  client.close();

  await assert.rejects(pending, /closed/i);
  assert.equal(closeCount(), 1);
});

test('a throwing event predicate rejects its wait without escaping receive or hanging requests', async () => {
  const {client} = fixture();
  const wait = client.nextEvent(() => { throw new Error('bad predicate'); });
  const request = client.request('still-live', {});

  assert.doesNotThrow(() => client.receive({method: 'event'}));
  client.receive({id: 1, result: 'done'});

  await assert.rejects(wait, /bad predicate/);
  assert.equal(await request, 'done');
});

test('notify sends a notification envelope', () => {
  const {client, sent} = fixture();
  client.notify('progress', {percent: 50});
  assert.deepEqual(sent, [{method: 'progress', params: {percent: 50}}]);
});
