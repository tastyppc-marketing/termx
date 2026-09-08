function asError(value, fallback) {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : fallback);
}

function rpcError(payload) {
  const error = new Error(typeof payload?.message === 'string' ? payload.message : 'RPC error');
  if (payload && Object.hasOwn(payload, 'code')) error.code = payload.code;
  if (payload && Object.hasOwn(payload, 'data')) error.data = payload.data;
  return error;
}

function serializedError(reason) {
  const error = asError(reason, 'Request handler failed');
  const payload = {message: error.message};
  if (Object.hasOwn(error, 'code')) payload.code = error.code;
  if (Object.hasOwn(error, 'data')) payload.data = error.data;
  return payload;
}

function validId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export class RpcClient {
  #send;
  #closeTransport;
  #timeoutMs;
  #maxEvents;
  #onRequest;
  #nextId = 1;
  #pending = new Map();
  #eventWaits = new Set();
  #events = [];
  #disconnected = null;
  #transportClosed = false;

  constructor({send, close, timeoutMs = 10000, maxEvents = 256, onRequest} = {}) {
    if (typeof send !== 'function' || typeof close !== 'function') {
      throw new TypeError('send and close must be functions');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be non-negative');
    if (!Number.isInteger(maxEvents) || maxEvents < 0) throw new RangeError('maxEvents must be a non-negative integer');
    if (onRequest !== undefined && typeof onRequest !== 'function') throw new TypeError('onRequest must be a function');
    this.#send = send;
    this.#closeTransport = close;
    this.#timeoutMs = timeoutMs;
    this.#maxEvents = maxEvents;
    this.#onRequest = onRequest;
  }

  request(method, params, {timeoutMs = this.#timeoutMs} = {}) {
    if (this.#disconnected) return Promise.reject(this.#disconnected);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`RPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {resolve, reject, timer});
      try {
        this.#send({id, method, params});
      } catch (reason) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(asError(reason, 'RPC send failed'));
      }
    });
  }

  notify(method, params) {
    if (this.#disconnected) throw this.#disconnected;
    this.#send({method, params});
  }

  nextEvent(predicate, {timeoutMs = this.#timeoutMs} = {}) {
    if (typeof predicate !== 'function') return Promise.reject(new TypeError('predicate must be a function'));
    if (this.#disconnected) return Promise.reject(this.#disconnected);

    for (let index = 0; index < this.#events.length; index += 1) {
      let matches;
      try {
        matches = predicate(this.#events[index]);
      } catch (reason) {
        return Promise.reject(asError(reason, 'Event predicate failed'));
      }
      if (matches) return Promise.resolve(this.#events.splice(index, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const wait = {predicate, resolve, reject, timer: undefined};
      wait.timer = setTimeout(() => {
        if (!this.#eventWaits.delete(wait)) return;
        reject(new Error('RPC event wait timed out'));
      }, timeoutMs);
      this.#eventWaits.add(wait);
    });
  }

  receive(message) {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.#failClosed();
      const hasId = Object.hasOwn(message, 'id');
      const hasMethod = Object.hasOwn(message, 'method');
      const hasResult = Object.hasOwn(message, 'result');
      const hasError = Object.hasOwn(message, 'error');

      if (hasMethod) {
        if (typeof message.method !== 'string' || message.method.length === 0 || hasResult || hasError) return this.#failClosed();
        if (hasId) {
          if (!validId(message.id)) return this.#failClosed();
          this.#handleServerRequest(message);
        } else {
          this.#handleEvent(message);
        }
        return;
      }

      if (!hasId || !validId(message.id) || hasResult === hasError) return this.#failClosed();
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (hasError) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
    } catch (reason) {
      this.#failClosed(reason);
    }
  }

  disconnect(reason = new Error('RPC disconnected')) {
    if (this.#disconnected) return;
    this.#disconnected = asError(reason, 'RPC disconnected');
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#disconnected);
    }
    this.#pending.clear();
    for (const wait of this.#eventWaits) {
      clearTimeout(wait.timer);
      wait.reject(this.#disconnected);
    }
    this.#eventWaits.clear();
    this.#events.length = 0;
  }

  close() {
    this.disconnect(new Error('RPC closed'));
    this.#closeOnce();
  }

  #handleEvent(message) {
    let matched = false;
    for (const wait of [...this.#eventWaits]) {
      try {
        if (!wait.predicate(message)) continue;
        this.#eventWaits.delete(wait);
        clearTimeout(wait.timer);
        wait.resolve(message);
        matched = true;
        break;
      } catch (reason) {
        this.#eventWaits.delete(wait);
        clearTimeout(wait.timer);
        wait.reject(asError(reason, 'Event predicate failed'));
      }
    }
    if (matched) return;
    if (this.#events.length >= this.#maxEvents) {
      this.#failClosed(new Error('RPC event storage overflow'));
      return;
    }
    this.#events.push(message);
  }

  #handleServerRequest(message) {
    const handler = this.#onRequest;
    if (!handler) {
      queueMicrotask(() => this.#sendIfConnected({id: message.id, error: {code: -32601, message: 'Method not found'}}));
      return;
    }
    Promise.resolve()
      .then(() => handler(message.method, message.params))
      .then(
        result => this.#sendIfConnected({id: message.id, result}),
        reason => this.#sendIfConnected({id: message.id, error: serializedError(reason)}),
      );
  }

  #sendIfConnected(message) {
    if (this.#disconnected) return;
    try {
      this.#send(message);
    } catch (reason) {
      this.#failClosed(reason);
    }
  }

  #failClosed(reason = new Error('Malformed RPC envelope')) {
    this.disconnect(asError(reason, 'Malformed RPC envelope'));
    this.#closeOnce();
  }

  #closeOnce() {
    if (this.#transportClosed) return;
    this.#transportClosed = true;
    try {
      this.#closeTransport();
    } catch {
      // The client is already settled; transport cleanup cannot reopen it.
    }
  }
}
