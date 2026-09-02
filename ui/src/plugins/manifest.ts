/**
 * Where a plugin panel can be put (menubar spec). `tab` is a tab of its own,
 * `split` a pane beside the focused one, `window` a dedicated OS window (a tab
 * torn out on open — the existing tear-out path, not a new window kind).
 */
export type PluginSurface = "tab" | "split" | "window";

/** Every surface TermX knows, in the order the launcher's chips print them. */
export const PLUGIN_SURFACES: readonly PluginSurface[] = ["tab", "split", "window"];

export interface PluginSurfaces {
  default: PluginSurface;
  allowed: PluginSurface[];
}

/** The smallest box a panel can still be itself in, in CSS pixels. */
export interface PluginMinSize {
  width: number;
  height: number;
}

/**
 * What a manifest that says nothing about placement means. Tab-or-split, tab by
 * default: exactly what Showroom and Recall already do, so the field arriving
 * changes nothing for a plugin that predates it.
 */
export const DEFAULT_PLUGIN_SURFACES: PluginSurfaces = {
  default: "tab",
  allowed: ["tab", "split"],
};

/** The floor under a panel with no opinion — below this a split is a squeeze. */
export const DEFAULT_PLUGIN_MIN_SIZE: PluginMinSize = { width: 320, height: 200 };

export interface PluginManifest {
  manifest: 1;
  id: string;
  name: string;
  icon: string;
  start: { command: string; args: string[] };
  singleton: boolean;
  discovery: { runtimeFile: string; healthPath: string };
  panel: { path: string };
  /**
   * Placement, RESOLVED. `parseManifest` always fills both of these in, so a
   * manifest that came through the parser never needs a fallback at the point
   * of use. They stay optional on the type for the manifests that did NOT come
   * through it — the bundled table, and every hand-written test fixture — which
   * `surfacesOf` / `minSizeOf` resolve on the caller's behalf.
   */
  surfaces?: PluginSurfaces;
  minSize?: PluginMinSize;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Plugin ids double as registry keys, file-name fragments and menu identities,
 * so they stay lowercase-and-hyphens: that keeps "Showroom" and "showroom" from
 * ever coexisting as two entries for one plugin on a case-insensitive OS.
 */
export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_PATTERN.test(id);
}

/** Panel and health paths are joined onto an origin, so they must be rooted. */
function isRootedPath(value: unknown): value is string {
  return isNonEmptyString(value) && value.startsWith("/");
}

function isPluginSurface(value: unknown): value is PluginSurface {
  return typeof value === "string"
    && (PLUGIN_SURFACES as readonly string[]).includes(value);
}

/**
 * The allowed list a manifest really declares: known surfaces only, first
 * appearance kept, and the whole field discarded when nothing usable survives.
 *
 * Unknown surfaces are DROPPED rather than refused. A manifest written against
 * a later TermX must still open on this one — refusing the field outright would
 * make a forward-looking plugin unopenable, which is the opposite of tolerant.
 */
function parseAllowed(value: unknown): PluginSurface[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const allowed = [...new Set(value.filter(isPluginSurface))];
  return allowed.length > 0 ? allowed : null;
}

/**
 * Resolve `surfaces` against the defaults. Never throws and never refuses:
 * every shape that is not a usable declaration falls back whole.
 *
 * A `default` outside `allowed` resolves to the FIRST allowed surface, which is
 * the manifest's own stated preference order — and `parseManifestWarnings`
 * reports it so Settings can say so rather than silently disagreeing with the
 * file on disk.
 */
function parseSurfaces(value: unknown): PluginSurfaces {
  if (!isRecord(value)) {
    return { ...DEFAULT_PLUGIN_SURFACES, allowed: [...DEFAULT_PLUGIN_SURFACES.allowed] };
  }
  const allowed = parseAllowed(value.allowed)
    ?? [...DEFAULT_PLUGIN_SURFACES.allowed];
  const declared = value.default;
  const preferred = isPluginSurface(declared) && allowed.includes(declared)
    ? declared
    : allowed[0]!;
  return { default: preferred, allowed };
}

function parseDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/// Each dimension falls back on its own: a manifest that gets the width right
/// and fumbles the height should keep the half it got right.
function parseMinSize(value: unknown): PluginMinSize {
  if (!isRecord(value)) {
    return { ...DEFAULT_PLUGIN_MIN_SIZE };
  }
  return {
    width: parseDimension(value.width, DEFAULT_PLUGIN_MIN_SIZE.width),
    height: parseDimension(value.height, DEFAULT_PLUGIN_MIN_SIZE.height),
  };
}

/// The resolved placement of ANY manifest, parsed or hand-written.
export function surfacesOf(manifest: PluginManifest): PluginSurfaces {
  return manifest.surfaces
    ?? { ...DEFAULT_PLUGIN_SURFACES, allowed: [...DEFAULT_PLUGIN_SURFACES.allowed] };
}

export function minSizeOf(manifest: PluginManifest): PluginMinSize {
  return manifest.minSize ?? { ...DEFAULT_PLUGIN_MIN_SIZE };
}

/**
 * Manifest problems that do NOT make it unusable — the plugin still opens, but
 * not quite as its file asked.
 *
 * Kept apart from `parseManifestErrors` on purpose: an error means there is no
 * manifest, a warning means there is one and TermX disagreed with a detail of
 * it. Settings shows both, and only the errors take the Open button away.
 */
export function parseManifestWarnings(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.surfaces)) {
    return [];
  }
  const resolved = parseSurfaces(value.surfaces);
  const declared = value.surfaces.default;
  if (declared === undefined || declared === resolved.default) {
    return [];
  }
  const printed = typeof declared === "string" ? declared : JSON.stringify(declared);
  return [
    `surfaces.default "${printed}" is not in surfaces.allowed; `
      + `using "${resolved.default}".`,
  ];
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
  if (!isNonEmptyString(value.id) || !isValidPluginId(value.id)) {
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
  if (!isRootedPath(discovery.healthPath)) {
    errors.push("discovery.healthPath");
  }

  const panel = isRecord(value.panel) ? value.panel : {};
  if (!isRootedPath(panel.path)) {
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
    surfaces: parseSurfaces(value.surfaces),
    minSize: parseMinSize(value.minSize),
  };
}

/** Expand Windows-style variables while preserving placeholders unknown to TermX. */
export function expandEnv(
  path: string,
  env: Record<string, string | undefined>,
): string {
  // Windows environment variable names are case-insensitive, so a manifest
  // writing %appdata% must resolve against the APPDATA key exactly as cmd would.
  const byLowerName = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      byLowerName.set(key.toLowerCase(), value);
    }
  }

  return path.replace(/%([^%]+)%/g, (placeholder, name: string) => {
    return env[name] ?? byLowerName.get(name.toLowerCase()) ?? placeholder;
  });
}
