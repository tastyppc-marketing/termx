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
  parseManifestWarnings,
  type PluginManifest,
  type PluginSurface,
} from "../plugins/manifest";
import type { PluginNative } from "../plugins/native";
import { autostartOf, type PluginsStore } from "../plugins/registry";
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
  /**
   * Opens the plugin, on the surface the pressed button names. Absent where no
   * workspace is wired.
   *
   * The surface is passed rather than assumed because the workspace's own entry
   * point defaults to the MANIFEST's preferred surface, and a button labelled
   * "Open as tab" that splits instead would be lying about what it does.
   */
  onOpen?(pluginId: string, surface?: PluginSurface): void;
  /** Injected by tests; production uses the OS folder dialog. */
  pickFolder?: FolderPicker;
  /** Injected by tests; production uses the manifests bundled with TermX. */
  bundled?: Record<string, PluginManifest>;
}

/** What reading a plugin folder told us: a manifest, a reason, or neither yet. */
interface FolderDetail {
  manifest: PluginManifest | null;
  problem: string | null;
  /**
   * A detail TermX overrode but could still work around - kept apart from
   * `problem` because the two have opposite consequences. A problem means there
   * is no usable manifest, so the row loses its Open button and its switch; a
   * warning means the plugin runs, just not exactly as its file asked.
   */
  warning: string | null;
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
  /** See `FolderDetail.warning`: says so, gates nothing. */
  warning: string | null;
  /** "Start with TermX" - main brings this plugin up at boot. */
  autostart: boolean;
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
    return { manifest: null, problem: "Folder unavailable", warning: null };
  }

  if (text === null) {
    const fallback = bundled[id];
    return fallback
      ? { manifest: fallback, problem: null, warning: null }
      : { manifest: null, problem: "Manifest missing", warning: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The exception text is a parser's, not a user's: it names byte offsets in
    // a file the user never asked to read. The field list below is the useful
    // half, and it needs a document that at least parsed.
    return { manifest: null, problem: "Manifest is not valid JSON", warning: null };
  }
  const manifest = parseManifest(raw);
  if (!manifest) {
    return {
      manifest: null,
      problem: `Manifest invalid: ${parseManifestErrors(raw).join(", ")}`,
      warning: null,
    };
  }

  // The registry key, not the manifest, is what the lifecycle and the layout
  // blob start from — so a folder whose manifest names some other plugin can
  // never be started under this row. Reporting it healthy would put an "Open
  // as tab" button on a plugin that refuses to open, with nothing on screen
  // saying why.
  if (manifest.id !== id) {
    return {
      manifest: null,
      problem: `This folder's manifest says ${manifest.id}, not ${id}.`,
      warning: null,
    };
  }
  // Only a manifest that PARSED can be warned about: a warning is advice on a
  // working plugin, and there is nothing to advise when there is no plugin.
  return {
    manifest,
    problem: null,
    warning: parseManifestWarnings(raw)[0] ?? null,
  };
}

/**
 * Last segment of a Windows or POSIX path, lowercased to match plugin ids.
 *
 * This is the ONLY place the panel interprets a folder string, and it
 * normalises what matters here: repeated and trailing separators fall out of
 * the filter, and case falls out of the lowercasing, so `C:\code\Showroom\`
 * and `\\server\share\showroom` both answer "showroom".
 *
 * Paths are deliberately NOT normalised anywhere else. Identity is the
 * manifest's `id`, never the folder: two spellings of one folder collide on
 * the id and are refused as a duplicate, and the registry stores whatever
 * string the picker returned so the value the user chose is the value TermX
 * hands back to the OS. The only cost is that re-spelling a path counts as a
 * change to `folderKey` and re-reads that folder once.
 */
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

  /** Guards the picker synchronously; `picking` only disables the buttons. */
  const pickingRef = useRef(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Id of a just-removed plugin, until focus has been placed after it. */
  const [removedId, setRemovedId] = useState<string | null>(null);

  useEffect(() => {
    if (removedId === null) {
      return;
    }
    setRemovedId(null);
    // Confirming destroys the button that had focus — with the whole row, for
    // a folder plugin. Focus would fall to <body>, and the Settings surface's
    // Esc guard only acts while focus is inside the surface, so the keyboard
    // user would be stuck in Settings until they clicked something. Runs after
    // the commit, when the replacement control actually exists.
    const root = panelRef.current;
    if (!root) {
      return;
    }
    // A bundled row survives its own removal and drops back to "No folder
    // added yet", so the next thing to do is right there in the row. Plugin
    // ids are /^[a-z0-9][a-z0-9-]*$/ (manifest.ts), so they are safe to
    // interpolate into a selector.
    const inRow = root.querySelector<HTMLElement>(
      `.settings-plugin[data-plugin-id="${removedId}"] [data-plugin-action="add-folder"]`,
    );
    const target =
      inRow ??
      root.querySelector<HTMLElement>("[data-testid='plugins-add']") ??
      // Last resort: the surface itself is focusable (tabIndex -1) purely so
      // there is always somewhere inside it for focus to be.
      root.closest<HTMLElement>(".settings-surface");
    target?.focus();
  }, [removedId]);

  useEffect(() => {
    if (confirming === null) {
      return;
    }
    // An armed destructive button left sitting on screen is a trap for the
    // next stray click, so it stands itself back down.
    const timer = setTimeout(() => setConfirming(null), CONFIRM_RESET_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

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
          warning: entry ? details[id]?.warning ?? null : null,
          autostart: entry ? autostartOf(entry) : false,
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
        let folder: string | null;
        try {
          folder = await pickFolder({ title: "Choose a plugin folder" });
        } catch {
          // A picker that rejects — no dialog plugin, a denied capability —
          // used to escape this callback as an unhandled rejection, leaving a
          // click that did nothing and a panel that said nothing.
          setError("The folder picker could not be opened.");
          return;
        }
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
    <div className="settings-plugins" ref={panelRef}>
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
                    <span className="settings-plugin__status" title={row.problem}>
                      {row.problem}
                    </span>
                  )}
                  {/* Same shape as a problem, in the caution colour rather than
                      the error one, and it gates nothing: the plugin works. */}
                  {row.warning === null ? null : (
                    <span
                      className="settings-plugin__status settings-plugin__status--warn"
                      title={row.warning}
                    >
                      {row.warning}
                    </span>
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
                  ariaLabel={`Enabled: ${row.name}`}
                  checked={row.enabled}
                  // Nothing to switch on without a folder, and nothing to
                  // switch on when the folder is broken — the lifecycle would
                  // refuse it either way. Switching OFF stays available
                  // whatever the state: a row that broke while it was on must
                  // not be trapped there.
                  disabled={
                    row.path === null || (!row.enabled && row.problem !== null)
                  }
                  onToggle={(checked) => store.setEnabled(row.id, checked)}
                />
                <Toggle
                  name={`plugin-autostart-${row.id}`}
                  label="Start with TermX"
                  ariaLabel={`Start with TermX: ${row.name}`}
                  checked={row.autostart}
                  // Gated harder than Enabled, and deliberately. Enabled is a
                  // statement of intent that survives a broken folder; this is
                  // an instruction TermX has to CARRY OUT at every launch, so
                  // it is only offered for a plugin that could actually start.
                  // Switching OFF stays available whatever the state, exactly
                  // as Enabled does: a row that broke while it was on must not
                  // be trapped there, still starting at every launch and
                  // failing. A `warning` does not gate it - the plugin runs.
                  disabled={
                    !row.autostart
                    && (row.path === null || !row.enabled || row.problem !== null)
                  }
                  onToggle={(checked) => store.setAutostart(row.id, checked)}
                />
                {onOpen && row.enabled && row.path !== null && row.problem === null ? (
                  <button
                    type="button"
                    className="settings-plugins__action"
                    aria-label={`Open as tab: ${row.name}`}
                    onClick={() => onOpen(row.id, "tab")}
                  >
                    Open as tab
                  </button>
                ) : null}
                {row.path === null ? (
                  <button
                    type="button"
                    className="settings-plugins__action"
                    data-plugin-action="add-folder"
                    aria-label={`Add folder: ${row.name}`}
                    disabled={picking}
                    onClick={() => void addFolder(row.id)}
                  >
                    Add folder…
                  </button>
                ) : null}
                {/* Repointing in one step, for the row that cannot be dropped
                    and re-added: removing a bundled plugin's folder only
                    clears the path and leaves the catalog row behind, so
                    without this, moving Showroom means Remove, confirm, then
                    Add folder — three steps and a row that looks uninstalled
                    in between. A folder plugin needs none of that; Remove
                    takes its row with it. */}
                {row.bundled && row.path !== null ? (
                  <button
                    type="button"
                    className="settings-plugins__action"
                    aria-label={`Change folder: ${row.name}`}
                    disabled={picking}
                    onClick={() => void addFolder(row.id)}
                  >
                    Change folder…
                  </button>
                ) : null}
                {/* Remove clears the registry entry, so it appears wherever
                    there is one. For a folder plugin that takes the row with
                    it; for a bundled plugin the catalog row stays and falls
                    back to "No folder added yet", which is the only way to
                    forget a wrong Showroom folder short of editing
                    plugins_v1.json by hand. */}
                {row.path === null ? null : (
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
                        ? `Confirm remove: ${row.name}`
                        : row.bundled
                          ? `Remove folder: ${row.name}`
                          : `Remove: ${row.name}`
                    }
                    // Claims Esc for as long as it is armed. Arming focuses
                    // the button and blur disarms it, so "armed" and "focused"
                    // are the same state — which is what lets the surface
                    // decide by asking where focus is, rather than by a
                    // listener order neither side can rely on.
                    {...(confirming === row.id ? { "data-esc-guard": "" } : {})}
                    onClick={() => {
                      if (confirming === row.id) {
                        setConfirming(null);
                        store.remove(row.id);
                        setRemovedId(row.id);
                      } else {
                        setConfirming(row.id);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (confirming === row.id && event.key === "Escape") {
                        event.preventDefault();
                        setConfirming(null);
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
