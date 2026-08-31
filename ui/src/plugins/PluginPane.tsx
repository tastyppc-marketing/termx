import type { PaneSessionState } from "../workspace/WorkspaceController";
import "./PluginPane.css";

export interface PluginPaneProps {
  /** The pane's projected state; `status` is "plugin". */
  state: PaneSessionState;
  /** `manifest.name` — the panel's own name, in the title bar and the cards. */
  name: string;
  /** `manifest.icon` — a bare glyph; there is no icon library in this app. */
  icon: string;
  /**
   * `manifest.panel.path`, appended to the state's ORIGIN. The two halves stay
   * separable: the origin is discovered per boot (the port moves), the path is
   * a manifest constant.
   */
  panelPath: string;
  /** Re-run ensure-up for this pane's plugin, KEEPING the pane. */
  onRelaunch(): void;
  /** Take the pane out of the layout. Never touches the daemon. */
  onDismiss(): void;
}

/**
 * The only origins a panel may be framed from: this machine's loopback, any
 * port. Anchored at both ends, so `http://127.0.0.1.evil.test` (a subdomain of
 * someone else's zone) and `http://127.0.0.1:7345@evil.test` (userinfo, where
 * the real host is what follows the `@`) are both refused rather than read as
 * loopback. The CSP's `frame-src` says the same thing at the webview level;
 * this is the half that can explain itself to the user instead of rendering an
 * empty rectangle.
 *
 * Case-insensitive because a host is, but deliberately NOT widened beyond an
 * origin: no trailing slash, no path, no query, no fragment, no `[::1]`.
 * `pluginUrl` is a normalized origin by construction — `lifecycle.ts` builds it
 * as `http://127.0.0.1:${port}` from the port in the runtime file, and the Rust
 * probe validator only ever accepts 127.0.0.1/localhost — so anything with more
 * in it did not come from that path, and the narrow pattern is what makes that
 * detectable instead of tolerated.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

/** Shown instead of a frame when the plugin hands back an address we refuse. */
const NON_LOCAL_REASON = "The plugin reported a non-local address.";

/**
 * Join the manifest's panel path onto the plugin's origin, or refuse.
 *
 * String concatenation cannot do this job. `panel.path` is checked for a
 * leading "/" by the manifest parser and nothing else, and two shapes escape
 * the origin: `@evil.com/` is not rooted at all, so `origin + path` lands it in
 * the URL's USERINFO slot and the real host becomes `evil.com`; `//evil.com/`
 * IS rooted, passes that check, and is protocol-relative, so it resolves to
 * another host entirely. Parsing the result and comparing origins is the only
 * check that catches both — and it keeps a legitimate query string intact,
 * which a hand-rolled sanitiser would have to reinvent.
 */
function panelSrc(origin: string, panelPath: string): string | null {
  if (!panelPath.startsWith("/")) {
    return null;
  }
  try {
    const base = new URL(origin);
    const url = new URL(panelPath, base);
    return url.origin === base.origin ? url.href : null;
  } catch {
    // An unparseable origin or path is a refusal, never a thrown render.
    return null;
  }
}

/** What the health mark on the title bar means, for the screen reader. */
const HEALTH_LABEL: Record<"starting" | "up" | "down", string> = {
  starting: "Starting",
  up: "Running",
  down: "Not answering",
};

/**
 * `pluginError` is the ensure-up reason with whatever the process printed
 * appended (`reason\nstderr…`). The reason is a label; the tail is evidence.
 * Splitting them here keeps the card readable when the tail is 40 lines of
 * stack — and keeps the reason on one line when there is no tail at all.
 */
function splitError(error: string | undefined): { reason: string | null; tail: string | null } {
  if (error === undefined) {
    return { reason: null, tail: null };
  }
  const newline = error.indexOf("\n");
  if (newline === -1) {
    const only = error.trim();
    return { reason: only.length > 0 ? only : null, tail: null };
  }
  const reason = error.slice(0, newline).trim();
  const tail = error.slice(newline + 1).trim();
  return {
    reason: reason.length > 0 ? reason : null,
    tail: tail.length > 0 ? tail : null,
  };
}

/// A plugin panel in a pane slot (plugin spec §4). It is a sibling of
/// TerminalPane and SleepingPane inside `.split-pane`, not a wrapper around it,
/// so it inherits the pane's focus chrome and close button and differs only in
/// what fills the middle: the panel's own page once the plugin answers, a
/// waiting card while it starts, an offline card when it stops.
///
/// The iframe carries NO `sandbox` attribute. A plugin serves its own scripts
/// and its own storage from its loopback origin, and every sandbox flag strong
/// enough to matter breaks one of them; the CSP's `frame-src` — loopback hosts
/// only — is the boundary instead (`src/__tests__/csp.test.ts` pins it), and
/// `src` is additionally refused here unless the origin really is loopback.
///
/// `allow` delegates ONE Permissions-Policy feature, `clipboard-write`, and
/// nothing else: camera, microphone, geolocation, display-capture, payment and
/// the rest stay denied by omission, and `clipboard-read` is denied too — a
/// panel may put something on the clipboard, never read what is already there.
/// The grant is load-bearing rather than generous: the panel is cross-origin to
/// the app (TermX runs from `tauri://localhost`, a plugin from
/// `http://127.0.0.1:<port>`), and in a cross-origin frame `clipboard-write` is
/// policy-gated, so without it `navigator.clipboard.writeText` rejects and
/// Showroom's copy buttons fail SILENTLY — the worst failure shape there is.
///
/// What that leaves, stated rather than hidden: without `sandbox` the framed
/// page can still navigate the TOP window (`window.top.location = …`, which
/// would replace the whole TermX webview) and open popups — `allow-top-
/// navigation` is a sandbox flag, so there is no way to withhold it while
/// keeping same-origin scripts and storage, and `allow` is a Permissions-Policy
/// list, which does not cover navigation at all. In P1 the only plugin is
/// Showroom, running from a folder the user chose themselves, so the residual
/// is accepted and recorded; it is the thing to revisit before a third-party
/// plugin ships.
///
/// `credentialless` is deliberately absent too: it would strip the plugin
/// origin's own cookies, which is exactly the state a panel needs to keep.
export function PluginPane({
  state,
  name,
  icon,
  panelPath,
  onRelaunch,
  onDismiss,
}: PluginPaneProps) {
  const reported = state.pluginHealth ?? "starting";
  const origin = state.pluginUrl ?? null;
  // A reported-up plugin that names an address off this machine is a refusal,
  // not a wait: nothing further is coming, and the user is told why. The panel
  // PATH gets the same treatment as the origin — it can escape one too.
  const src =
    reported === "up" && origin !== null && LOOPBACK_ORIGIN.test(origin)
      ? panelSrc(origin, panelPath)
      : null;
  const foreign = reported === "up" && origin !== null && src === null;
  // "up" with no origin at all cannot be framed either, but that one IS a wait:
  // what the pane shows follows what it can actually draw, never a label.
  const health = src !== null ? "up" : foreign || reported === "down" ? "down" : "starting";
  const { reason, tail } = foreign
    ? { reason: NON_LOCAL_REASON, tail: null }
    : splitError(state.pluginError);

  return (
    <>
      <div className="split-pane__title plugin-pane__title" title={name}>
        <span className="plugin-pane__icon" aria-hidden="true">{icon}</span>
        <span className="plugin-pane__name">{name}</span>
        <span
          className={`plugin-pane__health plugin-pane__health--${health}`}
          role="img"
          aria-label={HEALTH_LABEL[health]}
        />
      </div>
      <div className={`plugin-pane plugin-pane--${health}`} data-testid="plugin-pane">
        {health === "up" ? (
          <iframe
            className="plugin-pane__frame"
            src={src ?? undefined}
            title={name}
            referrerPolicy="no-referrer"
            allow="clipboard-write"
          />
        ) : health === "starting" ? (
          <div className="plugin-pane__wait" role="status">
            <div className="plugin-pane__overline">Starting {name}…</div>
            <div className="plugin-pane__progress" aria-hidden="true" />
          </div>
        ) : (
          <div className="plugin-pane__card" role="status">
            <div className="plugin-pane__mark" aria-hidden="true">{icon}</div>
            <div className="plugin-pane__overline">Plugin offline</div>
            <div className="plugin-pane__name-large">{name}</div>
            <div
              className="plugin-pane__reason"
              title={reason ?? undefined}
            >
              {reason ?? "The panel is not answering on its loopback port."}
            </div>
            {tail !== null ? (
              <pre
                className="plugin-pane__stderr"
                tabIndex={0}
                aria-label={`${name} output`}
              >{tail}</pre>
            ) : null}
            <div className="plugin-pane__actions">
              <button
                type="button"
                className="plugin-pane__action plugin-pane__action--primary plugin-pane__relaunch"
                onClick={onRelaunch}
              >
                Relaunch
              </button>
              <button
                type="button"
                className="plugin-pane__action plugin-pane__dismiss"
                onClick={onDismiss}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
