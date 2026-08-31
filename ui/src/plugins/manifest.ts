export interface PluginManifest {
  manifest: 1;
  id: string;
  name: string;
  icon: string;
  start: { command: string; args: string[] };
  singleton: boolean;
  discovery: { runtimeFile: string; healthPath: string };
  panel: { path: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Return stable field paths so Settings can explain malformed manifests without
 * coupling callers to parser wording.
 */
export function parseManifestErrors(value: unknown): string[] {
  if (!isRecord(value)) {
    return ["manifest"];
  }

  const errors: string[] = [];
  if (value.manifest !== 1) {
    errors.push("manifest");
  }
  if (!isNonEmptyString(value.id)) {
    errors.push("id");
  }
  if (!isNonEmptyString(value.name)) {
    errors.push("name");
  }
  if (!isNonEmptyString(value.icon)) {
    errors.push("icon");
  }

  const start = isRecord(value.start) ? value.start : {};
  if (!isNonEmptyString(start.command)) {
    errors.push("start.command");
  }
  if (
    !Array.isArray(start.args) ||
    !start.args.every((arg) => typeof arg === "string")
  ) {
    errors.push("start.args");
  }

  if (typeof value.singleton !== "boolean") {
    errors.push("singleton");
  }

  const discovery = isRecord(value.discovery) ? value.discovery : {};
  if (!isNonEmptyString(discovery.runtimeFile)) {
    errors.push("discovery.runtimeFile");
  }
  if (!isNonEmptyString(discovery.healthPath)) {
    errors.push("discovery.healthPath");
  }

  const panel = isRecord(value.panel) ? value.panel : {};
  if (!isNonEmptyString(panel.path)) {
    errors.push("panel.path");
  }

  return errors;
}

/** Parse the Phase 1 manifest surface, deliberately ignoring future keys. */
export function parseManifest(value: unknown): PluginManifest | null {
  if (parseManifestErrors(value).length > 0 || !isRecord(value)) {
    return null;
  }

  const start = value.start as Record<string, unknown>;
  const discovery = value.discovery as Record<string, unknown>;
  const panel = value.panel as Record<string, unknown>;
  return {
    manifest: 1,
    id: value.id as string,
    name: value.name as string,
    icon: value.icon as string,
    start: {
      command: start.command as string,
      args: [...(start.args as string[])],
    },
    singleton: value.singleton as boolean,
    discovery: {
      runtimeFile: discovery.runtimeFile as string,
      healthPath: discovery.healthPath as string,
    },
    panel: { path: panel.path as string },
  };
}

/** Expand Windows-style variables while preserving placeholders unknown to TermX. */
export function expandEnv(
  path: string,
  env: Record<string, string | undefined>,
): string {
  return path.replace(/%([^%]+)%/g, (placeholder, name: string) => {
    return env[name] ?? placeholder;
  });
}
