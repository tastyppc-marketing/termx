/**
 * The credentials store is the only place in TermX that holds a secret, so the
 * tests below are as much about what must NOT happen (a plain password reaching
 * the file when encryption is on, a decrypt failure looking like an empty
 * password, a write waiting on a debounce) as about the round trip.
 *
 * The fake crypto is a reversible marker rather than a no-op: `enc:` plus the
 * reversed text never CONTAINS the plaintext, so "did the plaintext reach the
 * file?" is a real assertion.
 */

import { describe, expect, it, vi } from "vitest";
import type { AppFileName, AppFileStore } from "../../native/appFiles";
import {
  SSH_CREDENTIALS_FILE,
  createSshCredentialsStore,
  parseSshCredentials,
  serializeSshCredentials,
} from "../credentials";

interface FakeFiles extends AppFileStore {
  readonly writes: readonly string[];
  text: string | null;
  reads: number;
  failWrite: boolean;
}

function fakeFiles(initial: string | null = null): FakeFiles {
  const writes: string[] = [];
  const files: FakeFiles = {
    writes,
    text: initial,
    reads: 0,
    failWrite: false,
    read(name: AppFileName) {
      expect(name).toBe(SSH_CREDENTIALS_FILE);
      files.reads += 1;
      return Promise.resolve(files.text);
    },
    write(name: AppFileName, contents: string) {
      expect(name).toBe(SSH_CREDENTIALS_FILE);
      if (files.failWrite) {
        return Promise.reject(new Error("disk full"));
      }
      writes.push(contents);
      files.text = contents;
      return Promise.resolve();
    },
  };
  return files;
}

/** Reversible marker crypto: the "blob" never contains the plaintext. */
function fakeCrypto() {
  return {
    protect: vi.fn((plain: string) =>
      Promise.resolve(`enc:${[...plain].reverse().join("")}`),
    ),
    unprotect: vi.fn((data: string) =>
      data.startsWith("enc:")
        ? Promise.resolve([...data.slice(4)].reverse().join(""))
        : Promise.reject(new Error("not our blob")),
    ),
  };
}

function fileOf(hosts: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, hosts });
}

const PASSWORD = "not-a-real-password ";

describe("parseSshCredentials", () => {
  it("reads nothing out of a missing or corrupt file", () => {
    expect(parseSshCredentials(null)).toEqual({});
    expect(parseSshCredentials("")).toEqual({});
    expect(parseSshCredentials("{not json")).toEqual({});
    expect(parseSshCredentials("42")).toEqual({});
    expect(parseSshCredentials("[]")).toEqual({});
    expect(parseSshCredentials(JSON.stringify({ version: 1 }))).toEqual({});
    expect(parseSshCredentials(fileOf({}))).toEqual({});
  });

  it("drops host entries it cannot use and keeps the rest", () => {
    expect(
      parseSshCredentials(
        fileOf({
          good: { password: { scheme: "dpapi", data: "enc:xyz" } },
          alsoGood: { password: { scheme: "plain", data: "abc" } },
          noPassword: {},
          notAnObject: "nope",
          badScheme: { password: { scheme: "rot13", data: "abc" } },
          noData: { password: { scheme: "plain" } },
          emptyData: { password: { scheme: "plain", data: "" } },
        }),
      ),
    ).toEqual({
      good: { scheme: "dpapi", data: "enc:xyz" },
      alsoGood: { scheme: "plain", data: "abc" },
    });
  });

  it("round-trips through serialize in the documented file shape", () => {
    const text = serializeSshCredentials({
      myvps: { scheme: "dpapi", data: "enc:blob" },
    });
    expect(JSON.parse(text)).toEqual({
      version: 1,
      hosts: { myvps: { password: { scheme: "dpapi", data: "enc:blob" } } },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(parseSshCredentials(text)).toEqual({
      myvps: { scheme: "dpapi", data: "enc:blob" },
    });
  });
});

describe("createSshCredentialsStore", () => {
  it("stores encrypted and never writes the plaintext", async () => {
    const files = fakeFiles();
    const crypto = fakeCrypto();
    const store = createSshCredentialsStore(files, crypto);
    await store.ready();

    await store.setPassword("myvps", PASSWORD, true);

    expect(files.writes).toHaveLength(1);
    const written = files.writes[0]!;
    expect(written).not.toContain(PASSWORD);
    expect(written).toContain("enc:");
    expect(JSON.parse(written).hosts.myvps.password.scheme).toBe("dpapi");
    expect(await store.passwordFor("myvps")).toBe(PASSWORD);
  });

  it("stores plaintext, exactly as typed, when encryption is off", async () => {
    const files = fakeFiles();
    const crypto = fakeCrypto();
    const store = createSshCredentialsStore(files, crypto);
    await store.ready();

    await store.setPassword("myvps", PASSWORD, false);

    expect(crypto.protect).not.toHaveBeenCalled();
    expect(JSON.parse(files.writes[0]!).hosts.myvps.password).toEqual({
      scheme: "plain",
      data: PASSWORD, // trailing space survives: a password is never trimmed
    });
    expect(await store.passwordFor("myvps")).toBe(PASSWORD);
  });

  it("writes immediately — a typed password may not wait on a debounce", async () => {
    const files = fakeFiles();
    const store = createSshCredentialsStore(files, fakeCrypto());
    await store.ready();

    await store.setPassword("myvps", PASSWORD, true);
    expect(files.writes).toHaveLength(1);

    await store.removePassword("myvps");
    expect(files.writes).toHaveLength(2);
    expect(JSON.parse(files.writes[1]!).hosts).toEqual({});
  });

  it("keeps a password set before the load landed", async () => {
    const files = fakeFiles(
      fileOf({ old: { password: { scheme: "plain", data: "kept" } } }),
    );
    const store = createSshCredentialsStore(files, fakeCrypto());

    // No `await ready()` first: the user can hit Save before the read returns.
    await store.setPassword("fresh", PASSWORD, false);
    await store.flush();

    expect(store.hasPassword("old")).toBe(true);
    expect(store.hasPassword("fresh")).toBe(true);
    expect(Object.keys(JSON.parse(files.text!).hosts).sort()).toEqual([
      "fresh",
      "old",
    ]);
  });

  it("reports a stored password synchronously once hydrated", async () => {
    const files = fakeFiles(
      fileOf({ myvps: { password: { scheme: "plain", data: "pw" } } }),
    );
    const store = createSshCredentialsStore(files, fakeCrypto());
    await store.ready();

    expect(store.hasPassword("myvps")).toBe(true);
    expect(store.hasPassword("other")).toBe(false);
    expect(store.getSnapshot()).toEqual(new Set(["myvps"]));
    // Stable between changes, so useSyncExternalStore does not spin.
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("answers null rather than a wrong password when decryption fails", async () => {
    // A blob written by another Windows user, or a corrupt one.
    const files = fakeFiles(
      fileOf({ myvps: { password: { scheme: "dpapi", data: "alien-blob" } } }),
    );
    const store = createSshCredentialsStore(files, fakeCrypto());
    await store.ready();

    expect(await store.passwordFor("myvps")).toBeNull();
    // Still "has" one: the entry exists, so the UI offers Change/Remove.
    expect(store.hasPassword("myvps")).toBe(true);
  });

  it("answers null for a host with nothing stored", async () => {
    const store = createSshCredentialsStore(fakeFiles(), fakeCrypto());
    await store.ready();
    expect(await store.passwordFor("nobody")).toBeNull();
  });

  it("refuses to store anything when encryption fails", async () => {
    const files = fakeFiles();
    const crypto = fakeCrypto();
    crypto.protect.mockRejectedValueOnce(new Error("dpapi down"));
    const store = createSshCredentialsStore(files, crypto);
    await store.ready();

    await expect(store.setPassword("myvps", PASSWORD, true)).rejects.toThrow();
    // The alternative — quietly storing it in plain text — is the bug.
    expect(files.writes).toHaveLength(0);
    expect(store.hasPassword("myvps")).toBe(false);
  });

  it("re-encrypts every convertible entry when the setting flips", async () => {
    const files = fakeFiles(
      fileOf({
        one: { password: { scheme: "plain", data: "first" } },
        two: { password: { scheme: "plain", data: "second" } },
      }),
    );
    const crypto = fakeCrypto();
    const store = createSshCredentialsStore(files, crypto);
    await store.ready();

    await store.reencryptAll(true);

    const hosts = JSON.parse(files.text!).hosts;
    expect(hosts.one.password).toEqual({ scheme: "dpapi", data: "enc:tsrif" });
    expect(hosts.two.password).toEqual({ scheme: "dpapi", data: "enc:dnoces" });
    expect(await store.passwordFor("one")).toBe("first");

    await store.reencryptAll(false);
    expect(JSON.parse(files.text!).hosts.one.password).toEqual({
      scheme: "plain",
      data: "first",
    });
  });

  it("leaves an undecryptable entry alone rather than losing it", async () => {
    const files = fakeFiles(
      fileOf({
        alien: { password: { scheme: "dpapi", data: "alien-blob" } },
        mine: { password: { scheme: "plain", data: "mine" } },
      }),
    );
    const store = createSshCredentialsStore(files, fakeCrypto());
    await store.ready();

    await store.reencryptAll(true);

    const hosts = JSON.parse(files.text!).hosts;
    expect(hosts.alien.password).toEqual({ scheme: "dpapi", data: "alien-blob" });
    expect(hosts.mine.password).toEqual({ scheme: "dpapi", data: "enc:enim" });
  });

  it("writes nothing when re-encryption has nothing to do", async () => {
    const files = fakeFiles(
      fileOf({ one: { password: { scheme: "plain", data: "first" } } }),
    );
    const store = createSshCredentialsStore(files, fakeCrypto());
    await store.ready();

    await store.reencryptAll(false);
    expect(files.writes).toHaveLength(0);
  });

  it("notifies subscribers on every change and stops after unsubscribe", async () => {
    const files = fakeFiles();
    const store = createSshCredentialsStore(files, fakeCrypto());
    await store.ready();
    const seen = vi.fn();
    const stop = store.subscribe(seen);

    await store.setPassword("myvps", PASSWORD, true);
    expect(seen).toHaveBeenCalledTimes(1);
    await store.removePassword("myvps");
    expect(seen).toHaveBeenCalledTimes(2);
    // A no-op removal changes nothing, so it must not notify.
    await store.removePassword("myvps");
    expect(seen).toHaveBeenCalledTimes(2);

    stop();
    await store.setPassword("myvps", PASSWORD, true);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("survives a failed write without throwing at the caller", async () => {
    const files = fakeFiles();
    const onSaveError = vi.fn();
    const store = createSshCredentialsStore(files, fakeCrypto(), { onSaveError });
    await store.ready();
    files.failWrite = true;

    await store.setPassword("myvps", PASSWORD, true);
    await store.flush();

    expect(onSaveError).toHaveBeenCalledTimes(1);
    // The in-memory value still works for this session.
    expect(await store.passwordFor("myvps")).toBe(PASSWORD);
  });
});
