/**
 * The updater's data shapes. `UpdateResult` mirrors the Rust `check_for_updates`
 * payload field for field (camelCase); `UpdateState` is the hook's machine.
 */

/**
 * Local alias of the `updatePolicy` setting. Declared here, not imported from
 * settings, so the updater never drags the settings module into its graph.
 */
export type UpdatePolicy = "auto" | "ask";

export interface UpdateResult {
  status: "current" | "available" | "no-release";
  currentVersion: string;
  latestVersion: string | null;
  releaseTag: string | null;
  /** True when ANY qualifying release newer than the running one is forced. */
  forced: boolean;
  /** True when ANY release in that span changed the terminal daemon. */
  hostChanged: boolean;
  sha256: string | null;
  assetName: string | null;
  notesUrl: string | null;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; result: UpdateResult }
  | { kind: "downloading"; result: UpdateResult }
  | { kind: "ready"; result: UpdateResult; installerPath: string }
  | { kind: "installing"; result: UpdateResult }
  | { kind: "error"; message: string; result?: UpdateResult };
