/**
 * The Plugins section of Settings — the one place a plugin is added, enabled,
 * opened or removed.
 *
 * Per-plugin state cannot be a settings field (`TermxSettings` is flat and its
 * tests pin one section per key), so this panel reads `plugins_v1.json` through
 * `PluginsStore` and renders itself; `SETTINGS_SECTIONS` marks its section with
 * `panel: "plugins"` to route here instead of to the field list (spec §7).
 *
 * A plugin whose folder is unreadable, unmanifested or malformed still gets a
 * row, with the reason on it. The alternative — hiding it, or listing it as
 * healthy — leaves the user with a plugin that never opens and nothing on
 * screen that says why.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { pickFolder as pickFolderDialog, type FolderPicker } from "../native/dialog";
import { BUNDLED_MANIFESTS } from "../plugins/bundled";
import {
  parseManifest,
  parseManifestErrors,
  type PluginManifest,
} from "../plugins/manifest";
import type { PluginNative } from "../plugins/native";
import type { PluginsStore } from "../plugins/registry";
import { Toggle } from "./Toggle";

/**
 * What the workspace last observed about a plugin's process, mirroring the
 * pane's own four states (spec §7). A plugin with no entry has never been
 * opened in this window, which is not the same as one reporting `unknown`.
 */
export type PluginHealth = "starting" | "up" | "down" | "unknown";

/** What each health mark means, for the tooltip and the screen reader. */
const HEALTH_LABEL: Record<"starting" | "up" | "down", string> = {
  starting: "Starting",
  up: "Running",
  down: "Not answering",
};

export interface PluginsPanelProps {
  store: PluginsStore;
  native: PluginNative;
  /**
   * Live process health by plugin id, as the workspace sees it. Absent
   * entirely where no workspace is wired, so every row falls back to no mark.
   */
  health?: Record<string, PluginHealth>;
  /** Opens the plugin in a new tab. Absent where no workspace is wired. */
  onOpen?(pluginId: string): void;
  /** Injected by tests; production uses the OS folder dialog. */
  pickFolder?: FolderPicker;
  /** Injected by tests; production uses the manifests bundled with TermX. */
  bundled?: Record<string, PluginManifest>;
}

/** What reading a plugin folder told us: a manifest, a reason, or neither yet. */
interface FolderDetail {
  manifest: PluginManifest | null;
  problem: string | null;
}

interface PluginRow {
  id: string;
  name: string;
  icon: string;
  /** null = the plugin is known to TermX but no folder has been added. */
  path: string | null;
  enabled: boolean;
  bundled: boolean;
  problem: string | null;
  /**
   * null = nothing to show. Both an absent entry (no workspace wired, or the
   * plugin was never opened here) and a reported `unknown` land here: neither
   * is a state of the process, so neither earns a mark.
   */
  health: "starting" | "up" | "down" | null;
}

/** A plugin with no manifest at all still needs a mark in its row. */
const FALLBACK_ICON = "▣";

/** How long an armed Remove waits before standing itself back down. */
const CONFIRM_RESET_MS = 4000;

/** Longest folder string shown in full before the middle is elided. */
const PATH_BUDGET = 44;

/**
 * Shorten a folder for display by dropping its middle, keeping the volume and
 * the last two segments — `C:\…\showroom\plugin`.
 *
 * Deliberately not `direction: rtl`: the bidi algorithm reorders `C:\` and the
 * separators around it, so a Windows path renders as `\plugin\showroom…\:C`.
 * The tail is the half that identifies the plugin, and the head is the half
 * that says which machine or drive it lives on, so both stay; only the route
 * between them is elided, and the full path stays in the `title`.
 */
export function shortenPath(path: string, budget = PATH_BUDGET): string {
  if (path.length <= budget) {
    return path;
  }

  const separator = path.includes("\\") ? "\\" : "/";
  const unc = path.startsWith("\\\\") || path.startsWith("//");
  const segments = path.split(/[\\/]+/).filter((part) => part.length > 0);

  // A UNC head is two segments — `\\server\share` — and half of one names a
  // machine that does not exist.
  const headLength = unc ? 2 : 1;
  if (segments.length <= headLength + 2) {
    // Nothing between the head and the tail; an ellipsis here would claim
    // there are hidden folders when there are none.
    return path;
  }

  const rooted = !unc && (path.startsWith("\\") || path.startsWith("/"));
  const prefix = unc ? separator + separator : rooted ? separator : "";
  const head = prefix + segments.slice(0, headLength).join(separator);
  const tail = segments.slice(-2).join(separator);
  const shortened = `${head}${separator}…${separator}${tail}`;
  return shortened.length < path.length ? shortened : path;
}

/**
 * Resolve one folder to a manifest or a plain-language reason. A missing file
 * is only a problem for a plugin TermX does not already know: a first-party
 * plugin answers from the bundled manifest, so its repository stays untouched.
 */
async function describeFolder(
  id: string,
  path: string,
  bundled: Record<string, PluginManifest>,
  native: PluginNative,
): Promise<FolderDetail> {
  let text: string | null;
  try {
    text = await native.readManifest(path);
  } catch {
    return { manifest: null, problem: "Folder unavailable" };
  }

  if (text === null) {
    const fallback = bundled[id];
    return fallback
      ? { manifest: fallback, problem: null }
      : { manifest: null, problem: "Manifest missing" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The exception text is a parser's, not a user's: it names byte offsets in
    // a file the user never asked to read. The field list below is the useful
    // half, and it needs a document that at least parsed.
    return { manifest: null, problem: "Manifest is not valid JSON" };
  }
  const manifest = parseManifest(raw);
  return manifest
    ? { manifest, problem: null }
    : {
        manifest: null,
        problem: `Manifest invalid: ${parseManifestErrors(raw).join(", ")}`,
      };
}

/** Last segment of a Windows or POSIX path, lowercased to match plugin ids. */
function folderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter((part) => part.length > 0);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export function PluginsPanel({
  store,
  native,
  health,
  onOpen,
  pickFolder = pickFolderDialog,
  bundled = BUNDLED_MANIFESTS,
}: PluginsPanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [details, setDetails] = useState<Record<string, FolderDetail>>({});
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** Id of the plugin whose Remove button is armed, or null. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const confirmingRef = useRef<string | null>(null);
  confirmingRef.current = confirming;

  /** Guards the picker synchronously; `picking` only disables the buttons. */
  const pickingRef = useRef(false);

  useEffect(() => {
    if (confirming === null) {
      return;
    }
    // An armed destructive button left sitting on screen is a trap for the
    // next stray click, so it stands itself back down.
    const timer = setTimeout(() => setConfirming(null), CONFIRM_RESET_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  useEffect(() => {
    // Registered once on mount, which puts it ahead of the Settings surface's
    // own Esc guard (child effects run before their parent's). While a Remove
    // is armed, Esc disarms it instead of closing Settings; otherwise the key
    // passes straight through.
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || confirmingRef.current === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setConfirming(null);
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, []);

  // Re-read folders when an id or its path changes, never when `enabled` flips:
  // a toggle is instant and a disk read behind it would make it feel otherwise.
  //
  // JSON does the quoting, so there is no separator character to pick that a
  // path could not itself contain. The committed version used raw U+0000 and
  // U+0001 bytes for that job, which made the whole module binary to git, to
  // diffs and to any editor that strips control characters on save.
  const folderKey = JSON.stringify(
    Object.entries(state.plugins).map(([id, entry]) => [id, entry.path]),
  );

  useEffect(() => {
    let cancelled = false;
    const entries = Object.entries(store.getSnapshot().plugins);
    void (async () => {
      const resolved = await Promise.all(
        entries.map(
          async ([id, entry]) =>
            [id, await describeFolder(id, entry.path, bundled, native)] as const,
        ),
      );
      if (!cancelled) {
        setDetails(Object.fromEntries(resolved));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderKey, store, native, bundled]);

  const rows = useMemo<PluginRow[]>(() => {
    // Bundled plugins are listed whether or not a folder has been added, so
    // Showroom is discoverable from a clean install rather than a thing you
    // have to already know about.
    const ids = new Set([...Object.keys(state.plugins), ...Object.keys(bundled)]);
    return [...ids]
      .map((id) => {
        const entry = state.plugins[id];
        const manifest = details[id]?.manifest ?? bundled[id] ?? null;
        const reported = health?.[id];
        return {
          id,
          name: manifest?.name ?? id,
          icon: manifest?.icon ?? FALLBACK_ICON,
          path: entry?.path ?? null,
          enabled: entry?.enabled ?? false,
          bundled: bundled[id] !== undefined,
          // A folder that was never added has nothing to be wrong with it.
          problem: entry ? details[id]?.problem ?? null : null,
          health:
            reported === undefined || reported === "unknown" ? null : reported,
        };
      })
      .sort((a, b) =>
        a.bundled === b.bundled
          ? a.name.localeCompare(b.name)
          : a.bundled
            ? -1
            : 1,
      );
  }, [state, details, bundled, health]);

  /**
   * Pick a folder and install it. `expectedId` scopes the pick to one row: a
   * row's own "Add folder…" / "Change folder…" must not quietly install some
   * other plugin and leave the row it was clicked on still empty.
   */
  const addFolder = useCallback(
    async (expectedId?: string): Promise<void> => {
      // A ref, not the `picking` state: two clicks in one frame both read the
      // pre-paint `false`, both open a picker, and the second `add` retargets
      // what the first just installed.
      if (pickingRef.current) {
        return;
      }
      pickingRef.current = true;
      setPicking(true);
      try {
        const folder = await pickFolder({ title: "Choose a plugin folder" });
        if (folder === null) {
          // Cancelling is not a failure; leave whatever is on screen alone.
          return;
        }

        let text: string | null;
        try {
          text = await native.readManifest(folder);
        } catch {
          setError("That folder could not be read.");
          return;
        }

        let id: string;
        if (text === null) {
          const fallback = bundled[folderName(folder)];
          if (!fallback) {
            setError("No termx-plugin.json found in that folder.");
            return;
          }
          id = fallback.id;
        } else {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            setError("That termx-plugin.json is not valid JSON.");
            return;
          }
          const manifest = parseManifest(raw);
          if (!manifest) {
            setError(`Manifest invalid: ${parseManifestErrors(raw).join(", ")}`);
            return;
          }
          id = manifest.id;
        }

        // The manifest, never the folder name, decides the id — so a row's own
        // button can check that the user pointed it at the right plugin.
        if (expectedId !== undefined && id !== expectedId) {
          setError(`That folder holds ${id}, not ${expectedId}.`);
          return;
        }

        // Ids are the registry's keys: an unscoped add of an id already there
        // would silently repoint it, so say so instead. A scoped add is the
        // one case where repointing is the whole intent.
        if (expectedId === undefined && store.getSnapshot().plugins[id]) {
          setError("That plugin id is already installed.");
          return;
        }
        setError(null);
        store.add(id, folder);
      } finally {
        pickingRef.current = false;
        setPicking(false);
      }
    },
    [bundled, native, pickFolder, store],
  );

  return (
    <div className="settings-plugins">
      <div className="settings-subsection__title">Installed</div>
      {rows.length === 0 ? (
        <div className="settings-plugins__empty">
          <span className="settings-plugins__empty-title">No plugins</span>
          <span className="settings-plugins__empty-detail">
            Add a plugin's folder and it appears here, ready to open as a tab or
            a split.
          </span>
        </div>
      ) : (
        <ul className="settings-plugins__list">
          {rows.map((row) => (
            <li
              className={`settings-plugin${
                row.enabled ? "" : " settings-plugin--disabled"
              }`}
              data-plugin-id={row.id}
              key={row.id}
            >
              <span className="settings-plugin__icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="settings-plugin__main">
                <span className="settings-plugin__name">
                  <span className="settings-plugin__label">{row.name}</span>
                  {/* Two plugins may share a display name; the id is what the
                      registry, the layout blob and every error message key on,
                      so it is never hidden behind a name. Where the name IS the
                      id — no manifest — printing it twice is only noise. */}
                  {row.name === row.id ? null : (
                    <span className="settings-plugin__id">{row.id}</span>
                  )}
                  {row.bundled ? (
                    <span className="settings-plugin__tag">Bundled</span>
                  ) : null}
                  {row.problem === null ? null : (
                    <span className="settings-plugin__status">{row.problem}</span>
                  )}
                  {/* Only a plugin the workspace is actually running has health
                      to report. No entry — no workspace wired, or never opened
                      in this window — draws nothing rather than an "unknown"
                      mark that would read as a state the plugin is in. */}
                  {row.health === null ? null : (
                    <span
                      className={`settings-plugin__health settings-plugin__health--${row.health}`}
                      role="img"
                      title={HEALTH_LABEL[row.health]}
                      aria-label={HEALTH_LABEL[row.health]}
                    />
                  )}
                </span>
                {row.path === null ? (
                  <span className="settings-plugin__hint">
                    No folder added yet.
                  </span>
                ) : (
                  <span className="settings-plugin__path" title={row.path}>
                    {shortenPath(row.path)}
                  </span>
                )}
              </span>
              <span className="settings-plugin__actions">
                <Toggle
                  name={`plugin-enabled-${row.id}`}
                  label="Enabled"
                  // "Enabled" repeated down a list says nothing about which
                  // plugin the switch belongs to.
                  ariaLabel={`Enable ${row.name}`}
                  checked={row.enabled}
                  disabled={row.path === null}
                  onToggle={(checked) => store.setEnabled(row.id, checked)}
                />
                {onOpen && row.enabled && row.path !== null && row.problem === null ? (
                  <button
                    type="button"
                    className="settings-plugins__action"
                    aria-label={`Open ${row.name} as a tab`}
                    onClick={() => onOpen(row.id)}
                  >
                    Open as tab
                  </button>
                ) : null}
                {row.path === null ? (
                  <button
                    type="button"
                    className="settings-plugins__action"
                    aria-label={`Add a folder for ${row.name}`}
                    disabled={picking}
                    onClick={() => void addFolder(row.id)}
                  >
                    Add folder…
                  </button>
                ) : null}
                {/* A bundled row has no Remove, so repointing is its only way
                    out of a wrong or moved folder — otherwise the fix is to
                    hand-edit plugins_v1.json. A folder plugin can just be
                    removed and added again. */}
                {row.bundled && row.path !== null ? (
                  <button
                    type="button"
                    className="settings-plugins__action"
                    aria-label={`Change the folder for ${row.name}`}
                    disabled={picking}
                    onClick={() => void addFolder(row.id)}
                  >
                    Change folder…
                  </button>
                ) : null}
                {row.bundled ? null : (
                  // Confirm in place rather than in a dialog: the row being
                  // removed stays on screen and under the pointer, and one
                  // stray click can no longer drop a plugin.
                  //
                  // Removing leaves any open pane bound on purpose: the pane's
                  // next ensure-up refuses with "not installed" and shows its
                  // down card, which is the honest picture. Unbinding reserved
                  // session ids is the workspace controller's job, not a
                  // settings panel's.
                  <button
                    type="button"
                    className={`settings-plugins__action settings-plugins__action--danger${
                      confirming === row.id
                        ? " settings-plugins__action--confirm"
                        : ""
                    }`}
                    aria-label={
                      confirming === row.id
                        ? `Confirm removing ${row.name}`
                        : `Remove ${row.name}`
                    }
                    onClick={() => {
                      if (confirming === row.id) {
                        setConfirming(null);
                        store.remove(row.id);
                      } else {
                        setConfirming(row.id);
                      }
                    }}
                    onBlur={() => setConfirming(null)}
                  >
                    {confirming === row.id ? "Confirm remove" : "Remove"}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-plugins__add">
        <button
          type="button"
          className="settings-plugins__action settings-plugins__action--primary"
          data-testid="plugins-add"
          disabled={picking}
          onClick={() => void addFolder()}
        >
          Add plugin folder…
        </button>
        {error === null ? null : (
          <p className="settings-plugins__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="settings-section__note">
        A plugin folder holds a termx-plugin.json saying how to start it.
        Showroom is the exception — its manifest ships with TermX, so its own
        folder needs no file.
      </p>
    </div>
  );
}
