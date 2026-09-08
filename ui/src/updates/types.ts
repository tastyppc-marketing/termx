export interface UpdateResult {
  status: "current" | "available" | "no-release";
  currentVersion: string;
  latestVersion: string | null;
  releaseTag: string | null;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; result: UpdateResult }
  | { kind: "error"; message: string };
