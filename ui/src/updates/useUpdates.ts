/**
 * The in-app updater, as a hook. Checks the private release catalog at launch
 * and every six hours, downloads any available installer in the background,
 * and installs it only when the caller asks, or, on the "auto" policy, once
 * per launch: the very first check of a mount. A later poll may download but
 * never restarts the app mid-work. Forced releases and a snoozed version are
 * never auto-installed either; the forced modal and the banner own those
 * clicks.
 *
 * Every failure keeps the last result when there is one, so the status pill
 * can still name the version next to "Click to retry".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { UpdatePolicy, UpdateResult, UpdateState } from "./types";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const STATUSES: readonly string[] = ["current", "available", "no-release"];

const errorMessage = (error: unknown) => typeof error === "string" ? error
  : error instanceof Error ? error.message : "The update check is unavailable";

export interface UseUpdatesOptions {
  policy: UpdatePolicy;
  /** The version "Later" was last pressed on, or null. Never auto-installed. */
  snoozedVersion: string | null;
  onSnooze(version: string): void;
  /**
   * Runs BEFORE `install_update` when the release span changed the daemon:
   * the caller marks the pending host restart and stops the daemon so the
   * installer can replace it. Awaited when it returns a promise.
   */
  onHostChangeInstall?(): void | Promise<void>;
}

export function useUpdates(options: UseUpdatesOptions) {
  const [version, setVersion] = useState<string>();
  const [update, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef<UpdateState>({ kind: "idle" });
  const resultRef = useRef<UpdateResult | null>(null);
  const generation = useRef(0);
  const pending = useRef<Promise<UpdateResult> | null>(null);
  const checking = useRef<number | null>(null);
  const checksStarted = useRef(0);

  const setUpdate = useCallback((next: UpdateState) => {
    stateRef.current = next;
    if ("result" in next && next.result) resultRef.current = next.result;
    setUpdateState(next);
  }, []);

  const install = useCallback(async () => {
    const state = stateRef.current;
    if (state.kind !== "ready") return;
    const token = generation.current;
    setUpdate({ kind: "installing", result: state.result });
    try {
      if (state.result.hostChanged) await optionsRef.current.onHostChangeInstall?.();
      await invoke("install_update", { installerPath: state.installerPath });
    } catch (error) {
      if (generation.current === token) setUpdate({ kind: "error", message: errorMessage(error), result: state.result });
    }
  }, [setUpdate]);

  const startDownload = useCallback(async (result: UpdateResult, launch: boolean): Promise<string | null> => {
    if (result.status !== "available" || !result.releaseTag || !result.assetName || !result.sha256) return null;
    const token = generation.current;
    setUpdate({ kind: "downloading", result });
    let installerPath: string;
    try {
      installerPath = await invoke<string>("download_update", {
        tag: result.releaseTag, assetName: result.assetName, sha256: result.sha256,
      });
    } catch (error) {
      if (generation.current === token) setUpdate({ kind: "error", message: errorMessage(error), result });
      return null;
    }
    if (generation.current !== token) return installerPath;
    setUpdate({ kind: "ready", result, installerPath });
    const { policy, snoozedVersion } = optionsRef.current;
    if (launch && policy === "auto" && !result.forced && result.latestVersion !== snoozedVersion) {
      void install();
    }
    return installerPath;
  }, [install, setUpdate]);

  const check = useCallback(async () => {
    if (checking.current === generation.current) return;
    const token = generation.current;
    const launch = checksStarted.current === 0;
    checksStarted.current += 1;
    checking.current = token;
    setUpdate({ kind: "checking" });
    const request = pending.current ?? invoke<UpdateResult>("check_for_updates");
    pending.current = request;
    let result: UpdateResult;
    try {
      result = await request;
      if (!result || !STATUSES.includes(result.status)) throw new Error("GitHub returned an unreadable release result");
    } catch (error) {
      if (generation.current === token) setUpdate({ kind: "error", message: errorMessage(error) });
      return;
    } finally {
      if (pending.current === request) pending.current = null;
      if (checking.current === token) checking.current = null;
    }
    if (generation.current !== token) return;
    setUpdate({ kind: "checked", result });
    if (result.status === "available") void startDownload(result, launch);
  }, [setUpdate, startDownload]);

  useEffect(() => {
    const token = ++generation.current;
    void getVersion().then((value) => { if (generation.current === token) setVersion(value); }).catch(() => {});
    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL);
    return () => { generation.current++; clearInterval(timer); };
  }, [check]);

  /** Download (or re-download after a failure) the checked release. */
  const download = useCallback(async (): Promise<string | null> => {
    const state = stateRef.current;
    if (state.kind !== "checked" && state.kind !== "error") return null;
    const result = resultRef.current;
    if (!result) return null;
    return startDownload(result, false);
  }, [startDownload]);

  /** Open the release page (the "What's new" link) for the checked release. */
  const open = useCallback(async () => {
    const result = resultRef.current;
    if (!result || result.status !== "available" || !result.releaseTag) return;
    const token = generation.current;
    try {
      await invoke("open_update_release", { tag: result.releaseTag });
    } catch (error) {
      if (generation.current === token) setUpdate({ kind: "error", message: errorMessage(error), result });
    }
  }, [setUpdate]);

  /** "Later" on the optional banner: hand the offered version to the caller. */
  const snooze = useCallback(() => {
    const result = resultRef.current;
    if (result?.latestVersion) optionsRef.current.onSnooze(result.latestVersion);
  }, []);

  return { version, update, check, open, download, install, snooze };
}
