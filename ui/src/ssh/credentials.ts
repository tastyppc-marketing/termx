/**
 * SSH password store — `ssh_credentials_v1.json` (ssh-sessions spec §4, §6).
 *
 * The only place in TermX that holds a secret, so it is deliberately narrower
 * than the other app-file stores:
 *
 * - Nothing here ever returns "the passwords". A caller asks about ONE alias
 *   and gets one answer, so no code path can ever dump the set.
 * - Writes are immediate. A password the user just typed must survive the
 *   window closing a second later, so there is no debounce to lose it in.
 * - An encryption failure is an error, never a downgrade: storing plaintext
 *   because DPAPI hiccupped would break exactly the promise the setting makes.
 * - A decryption failure reads as "no password stored" (spec §7), because a
 *   blob written by another Windows user is not a password TermX can use — but
 *   the entry itself is left alone, so the user can replace or remove it.
 *
 * The sync surface (`hasPassword` / `getSnapshot`) is aliases only: enough to
 * label a button "Change password…", never enough to leak a value.
 */

import type { AppFileName, AppFileStore } from "../native/appFiles";

export const SSH_CREDENTIALS_FILE: AppFileName = "ssh_credentials_v1.json";

/** How `data` is encoded: a DPAPI blob (base64) or the raw password. */
export type SshSecretScheme = "dpapi" | "plain";

const SCHEMES: readonly SshSecretScheme[] = ["dpapi", "plain"];

export interface SshStoredSecret {
  readonly scheme: SshSecretScheme;
  readonly data: string;
}

/** Stored secrets by host alias — the parsed form of the file's `hosts` map. */
export type SshSecretsByAlias = Readonly<Record<string, SshStoredSecret>>;

/** The two commands the store needs; real ones are DPAPI (see sshNative.ts). */
export interface SshSecretCrypto {
  protect(plain: string): Promise<string>;
  unprotect(data: string): Promise<string>;
}

/** The frozen cross-lane contract: every other lane codes against this. */
export interface SshCredentialsStore {
  /** Resolves once the initial load has been applied. */
  ready(): Promise<void>;
  /** Awaits any in-flight write. */
  flush(): Promise<void>;
  /** Decrypted password for the alias, or null (none stored / unusable blob). */
  passwordFor(alias: string): Promise<string | null>;
  /** Stores per the scheme argument, overwriting. Throws if encryption fails. */
  setPassword(alias: string, plain: string, encrypt: boolean): Promise<void>;
  removePassword(alias: string): Promise<void>;
  /** Sync, from the hydrated snapshot. */
  hasPassword(alias: string): boolean;
  /** Aliases with a stored password; stable ref between changes. */
  getSnapshot(): ReadonlySet<string>;
  /** Re-writes every convertible entry in the new scheme (settings flip). */
  reencryptAll(encrypt: boolean): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface SshCredentialsStoreOptions {
  onSaveError?: (error: unknown) => void;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecret(value: unknown): SshStoredSecret | null {
  if (!isRecordObject(value)) {
    return null;
  }
  const { scheme, data } = value;
  if (
    !(SCHEMES as readonly unknown[]).includes(scheme) ||
    typeof data !== "string" ||
    data.length === 0
  ) {
    return null;
  }
  return { scheme: scheme as SshSecretScheme, data };
}

/**
 * Parse the store file (null = missing). Never throws: a corrupt file reads as
 * "no stored passwords" (spec §7), which costs the user one re-entry and can
 * never wedge the connect flow.
 */
export function parseSshCredentials(
  text: string | null,
): Record<string, SshStoredSecret> {
  const hosts: Record<string, SshStoredSecret> = {};
  if (text === null) {
    return hosts;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return hosts;
  }
  if (!isRecordObject(raw) || !isRecordObject(raw.hosts)) {
    return hosts;
  }
  for (const [alias, entry] of Object.entries(raw.hosts)) {
    if (alias.length === 0 || !isRecordObject(entry)) {
      continue;
    }
    const secret = parseSecret(entry.password);
    if (secret !== null) {
      hosts[alias] = secret;
    }
  }
  return hosts;
}

export function serializeSshCredentials(hosts: SshSecretsByAlias): string {
  const body = {
    version: 1,
    hosts: Object.fromEntries(
      Object.entries(hosts).map(([alias, password]) => [alias, { password }]),
    ),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

const NO_ALIASES: ReadonlySet<string> = new Set<string>();

class SshCredentials implements SshCredentialsStore {
  private hosts: SshSecretsByAlias = {};
  private aliases: ReadonlySet<string> = NO_ALIASES;
  private readonly files: AppFileStore;
  private readonly crypto: SshSecretCrypto;
  private readonly onSaveError?: (error: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    files: AppFileStore,
    crypto: SshSecretCrypto,
    options: SshCredentialsStoreOptions = {},
  ) {
    this.files = files;
    this.crypto = crypto;
    if (options.onSaveError) {
      this.onSaveError = options.onSaveError;
    }
    this.loaded = this.hydrate();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  ready = (): Promise<void> => this.loaded;

  flush = async (): Promise<void> => {
    await this.saveChain;
  };

  hasPassword = (alias: string): boolean => this.aliases.has(alias);

  getSnapshot = (): ReadonlySet<string> => this.aliases;

  passwordFor = async (alias: string): Promise<string | null> => {
    await this.loaded;
    const secret = this.hosts[alias];
    return secret === undefined ? null : await this.decode(secret);
  };

  setPassword = async (
    alias: string,
    plain: string,
    encrypt: boolean,
  ): Promise<void> => {
    await this.loaded;
    // Encrypt BEFORE committing: a throw here must leave the store untouched
    // rather than half-storing the secret in the clear.
    const secret = await this.encode(plain, encrypt);
    await this.commit({ ...this.hosts, [alias]: secret });
  };

  removePassword = async (alias: string): Promise<void> => {
    await this.loaded;
    if (!(alias in this.hosts)) {
      return;
    }
    const rest = { ...this.hosts };
    delete rest[alias];
    await this.commit(rest);
  };

  reencryptAll = async (encrypt: boolean): Promise<void> => {
    await this.loaded;
    const target: SshSecretScheme = encrypt ? "dpapi" : "plain";
    const next: Record<string, SshStoredSecret> = { ...this.hosts };
    let changed = false;
    for (const [alias, secret] of Object.entries(this.hosts)) {
      if (secret.scheme === target) {
        continue;
      }
      const plain = await this.decode(secret);
      // Not ours to read, so not ours to convert: keeping the entry is better
      // than dropping a password the rightful user may still want to replace.
      if (plain === null) {
        continue;
      }
      next[alias] = await this.encode(plain, encrypt);
      changed = true;
    }
    if (!changed) {
      return;
    }
    await this.commit(next);
  };

  /** Plaintext of a stored secret, or null when this user cannot read it. */
  private async decode(secret: SshStoredSecret): Promise<string | null> {
    if (secret.scheme === "plain") {
      return secret.data;
    }
    try {
      return await this.crypto.unprotect(secret.data);
    } catch {
      return null;
    }
  }

  private async encode(
    plain: string,
    encrypt: boolean,
  ): Promise<SshStoredSecret> {
    if (!encrypt) {
      // Stored exactly as typed — never trimmed, a password may end in a space.
      return { scheme: "plain", data: plain };
    }
    return { scheme: "dpapi", data: await this.crypto.protect(plain) };
  }

  private async hydrate(): Promise<void> {
    let text: string | null = null;
    try {
      text = await this.files.read(SSH_CREDENTIALS_FILE);
    } catch {
      text = null;
    }
    const stored = parseSshCredentials(text);
    if (Object.keys(stored).length === 0) {
      return;
    }
    // Every mutation awaits `loaded` first, so there is nothing to merge here.
    this.hosts = stored;
    this.aliases = new Set(Object.keys(stored));
    this.notify();
  }

  /**
   * Immediate, serialized write. Awaited by the caller so a Save button can
   * report a real failure, but a rejected write never escapes: the in-memory
   * value still serves this session's connects.
   */
  private async commit(hosts: SshSecretsByAlias): Promise<void> {
    this.hosts = hosts;
    this.aliases = new Set(Object.keys(hosts));
    this.notify();
    const text = serializeSshCredentials(hosts);
    this.saveChain = this.saveChain
      .then(() => this.files.write(SSH_CREDENTIALS_FILE, text))
      .catch((error: unknown) => {
        this.onSaveError?.(error);
      });
    await this.saveChain;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export function createSshCredentialsStore(
  files: AppFileStore,
  crypto: SshSecretCrypto,
  options: SshCredentialsStoreOptions = {},
): SshCredentialsStore {
  return new SshCredentials(files, crypto, options);
}
