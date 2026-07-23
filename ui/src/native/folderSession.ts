/**
 * Folder-picker → CreateSession plumbing (M2 T6).
 *
 * Headline flow: native open-folder dialog, then create a shell session whose
 * cwd is that folder. Context-menu helpers:
 *   - "Open folder here" — pick a folder (seeded from the source tab's cwd when
 *     available) and open a new session with the source tab's profile.
 *   - "Duplicate tab" — CreateSession with the same profile + cwd.
 *
 * UI chrome (sidebar menu wiring) lives in T5; this module is the pure
 * action layer they call.
 */

import type { SessionInfo } from "../host/protocol";
import {
  pickFolder,
  type FolderPicker,
  type PickFolderOptions,
} from "./dialog";

/** Default PTY size when the caller has no live pane dimensions. */
export const DEFAULT_SESSION_COLS = 120;
export const DEFAULT_SESSION_ROWS = 30;

/** Minimal host surface required for folder-session actions. */
export interface SessionCreator {
  createSession(options: {
    profile: string | null;
    cwd: string | null;
    cols: number;
    rows: number;
  }): Promise<SessionInfo>;
}

export interface CreateSessionSize {
  cols?: number;
  rows?: number;
}

export interface SessionTemplate {
  profile: string | null;
  cwd: string | null;
}

export interface FolderSessionDeps {
  client: SessionCreator;
  /** Injected in tests; production uses the Tauri dialog plugin. */
  pickFolder?: FolderPicker;
}

function resolveSize(size?: CreateSessionSize): { cols: number; rows: number } {
  return {
    cols: size?.cols ?? DEFAULT_SESSION_COLS,
    rows: size?.rows ?? DEFAULT_SESSION_ROWS,
  };
}

/**
 * Create a session with an explicit absolute cwd (host validates absolute path
 * + directory existence). Pass `cwd: null` only when deliberately using the
 * host default working directory.
 */
export async function createSessionWithCwd(
  client: SessionCreator,
  options: {
    profile: string | null;
    cwd: string | null;
  } & CreateSessionSize,
): Promise<SessionInfo> {
  const { cols, rows } = resolveSize(options);
  return client.createSession({
    profile: options.profile,
    cwd: options.cwd,
    cols,
    rows,
  });
}

/**
 * Headline: open the native folder picker, then CreateSession with that cwd.
 * Returns null if the user cancelled the dialog (no host request sent).
 */
export async function pickFolderAndCreateSession(
  deps: FolderSessionDeps,
  options: {
    profile?: string | null;
    picker?: PickFolderOptions;
  } & CreateSessionSize = {},
): Promise<SessionInfo | null> {
  const folder = await pickFolder(options.picker ?? {}, deps.pickFolder);
  if (folder === null) {
    return null;
  }
  return createSessionWithCwd(deps.client, {
    profile: options.profile ?? null,
    cwd: folder,
    cols: options.cols,
    rows: options.rows,
  });
}

/**
 * Context menu: "Open folder here".
 * Seeds the picker at the source tab's cwd when present, then creates a new
 * session with the source profile and the chosen folder as cwd.
 * Returns null if the user cancelled.
 */
export async function openFolderHere(
  deps: FolderSessionDeps,
  source: SessionTemplate,
  size?: CreateSessionSize,
): Promise<SessionInfo | null> {
  const pickerOptions: PickFolderOptions = {
    title: "Open folder",
    defaultPath: source.cwd ?? undefined,
  };
  return pickFolderAndCreateSession(deps, {
    profile: source.profile,
    picker: pickerOptions,
    cols: size?.cols,
    rows: size?.rows,
  });
}

/**
 * Context menu: "Duplicate tab" — same profile + cwd, fresh session/PTY.
 * Host still validates cwd if non-null; a null cwd duplicates the default-cwd
 * case.
 */
export async function duplicateTab(
  deps: FolderSessionDeps,
  source: SessionTemplate,
  size?: CreateSessionSize,
): Promise<SessionInfo> {
  return createSessionWithCwd(deps.client, {
    profile: source.profile,
    cwd: source.cwd,
    cols: size?.cols,
    rows: size?.rows,
  });
}
