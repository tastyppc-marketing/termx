import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { ChatOverlay } from "../chat/ChatOverlay";
import type { openChatFeed } from "../chat/feed";
import type { ChatDensity, ChatViewMode } from "../chat/types";
import { HostClient } from "../host/client";
import {
  xtermSearchDecorations,
  xtermTheme,
  type XtermPalette,
} from "../theme/deriveTokens";
import { currentThemeId, onThemeChange } from "../theme/ThemeProvider";
import { themeById } from "../theme/themes";
import { InputMarks, type InputMark } from "./inputMarks";
import {
  TerminalSessionBinding,
  type AttachmentClient,
  type TerminalPort,
  type TerminalSessionStatus,
} from "./TerminalSessionBinding";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPane.css";

export const PATH_LINK_REGEX =
  /(?:(?<![A-Za-z0-9+.\-\/\\])(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/(?!\/))|(?<![A-Za-z0-9+.\-:\/\\])(?![A-Za-z][A-Za-z0-9+.-]*:\/\/)[A-Za-z0-9_.-]+[\\/])[^\s\"'<>|]+/g;

export interface PaneHostClient extends AttachmentClient {
  onError(listener: (error: Error) => void): () => void;
  close(): void;
}

/** Host-recorded terminal size (SessionInfo cols/rows). */
export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalPresentation {
  terminal: TerminalPort;
  fit(): void;
  /**
   * Size the terminal to exact cols/rows, bypassing fit-to-container. Used to
   * restore the host-recorded dims BEFORE replay (spec §13). Optional so
   * existing presentations/fakes stay valid; without it the pane keeps the
   * legacy fit-first behaviour.
   */
  resize?(cols: number, rows: number): void;
  /**
   * Retint a LIVE terminal (theme spec §1: switching is instant). Optional so
   * existing presentations and test fakes stay valid; a presentation without
   * it simply keeps the palette it was built with.
   */
  setTheme?(palette: XtermPalette): void;
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  focus(): void;
  dispose(): void;
  /** Marker at the cursor line; undefined in the alternate screen buffer. */
  registerInputMarker(): InputMark | undefined;
  scrollToLine(line: number): void;
  /** Top buffer line of the current viewport. */
  viewportY(): number;
  /**
   * The rows currently on screen, as text. This is what the chat view's prompt
   * detector reads: a TUI prompt is never written to the transcript, but it IS
   * on the screen. Optional so existing presentations and fakes stay valid; a
   * presentation without it simply offers no prompt cards.
   */
  visibleLines?(): string[];
  /**
   * Reports whether the viewport is at the very top of the scrollback, on every
   * scroll. Optional: a presentation without it simply never offers the
   * earlier-output bar, which is the right default for one that cannot say.
   */
  onScroll?(listener: (atTop: boolean) => void): () => void;
}

/**
 * The chat view's binding to this pane (chat-view spec §1/§2). Present ONLY
 * when the pane is linked to a recognized agent session — an unlinked pane is
 * offered no switch at all, because a switch that opens the wrong
 * conversation is worse than no switch.
 */
export interface PaneChatProps {
  /** Absolute path of the linked transcript. */
  filePath: string;
  title: string;
  model?: string;
  mode: ChatViewMode;
  density: ChatDensity;
  /** Whether reasoning rows start open (independent of `density`). */
  showThinking: boolean;
  onModeChange(mode: ChatViewMode): void;
  onDensityChange(density: ChatDensity): void;
  onShowThinkingChange(showThinking: boolean): void;
  onOpenLinkPicker?: () => void;
  /** The pane was opened by a resume: the dock starts revealed (chat v2 §4). */
  bootReveal?: boolean;
  /** Injected feed opener (tests). */
  openFeed?: typeof openChatFeed;
}

export interface TerminalPaneDependencies {
  bootstrapSession(): Promise<{ client: PaneHostClient; sessionId: number }>;
  createPresentation(element: HTMLElement, onLink: (link: string) => void): TerminalPresentation;
  observeResize(element: HTMLElement, listener: () => void): () => void;
  activateLink(link: string): Promise<string | null>;
}

/** Reports one remote agent launch: `(sessionId, capture)` (spec §2). */
export type ConversationCaptureReporter = (
  sessionId: number,
  capture: { provider: "claude" | "codex"; id: string },
) => void;

type TerminalPaneProps =
  | {
      client?: undefined;
      sessionId?: undefined;
      dependencies?: TerminalPaneDependencies;
      onCwd?: (path: string, live: boolean) => void;
      onOutput?: (path: string) => void;
      onConversationCaptured?: ConversationCaptureReporter;
      recordedDims?: TerminalDimensions | null;
      chat?: PaneChatProps;
      suspended?: undefined;
      attachGeneration?: undefined;
      historyBefore?: undefined;
      onLoadEarlier?: undefined;
    }
  | {
      client: PaneHostClient;
      sessionId: number;
      dependencies?: TerminalPaneDependencies;
      onCwd?: (path: string, live: boolean) => void;
      /** OSC 9;77 deliverable report (polish P4); live registrations only. */
      onOutput?: (path: string) => void;
      /**
       * OSC 9;78 conversation capture from a tracked ssh pane (ssh-sessions
       * spec §2); live captures only. The session id is stamped here because
       * the pane is the only place that knows it.
       */
      onConversationCaptured?: ConversationCaptureReporter;
      /**
       * The session's host-recorded cols/rows (SessionInfo). When known the
       * terminal is sized to them before replay and only fits to the container
       * afterwards — the malformed-scrollback defense (spec §13).
       */
      recordedDims?: TerminalDimensions | null;
      /**
       * The host connection is down and this session is presumed still running.
       * The pane shows a reconnecting chip and keeps its scrollback — it must
       * never turn into a dead pane over a lost socket.
       */
      suspended?: boolean;
      /**
       * `HubSessionSnapshot.attachGeneration`. A binding cannot be revived once
       * it has been disconnected, so a change here rebuilds the whole terminal
       * against the new socket — that is what brings the pane back after a
       * reconnect.
       */
      attachGeneration?: number;
      /**
       * The oldest offset this pane still holds. Anything greater than zero
       * means the ring has evicted output that is only on disk now, so there is
       * something to offer. Zero or absent: nothing was ever lost.
       */
      historyBefore?: bigint | null;
      /** Open the spilled scrollback below `historyBefore`. */
      onLoadEarlier?: (beforeOffset: bigint) => void;
      /** Chat view binding; absent means this pane offers no chat (spec §2). */
      chat?: PaneChatProps;
    };

type PaneState =
  | { type: "loading" }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "runtime_error"; message: string }
  | { type: "exited"; exitCode: number | null }
  | { type: "disconnected" };

const defaultDependencies: TerminalPaneDependencies = {
  bootstrapSession: bootstrapFirstSession,
  createPresentation,
  observeResize,
  activateLink: activateTerminalLink,
};

export function TerminalPane(props: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const presentationRef = useRef<TerminalPresentation | null>(null);
  // The chat view writes through this; the terminal underneath never changes
  // hands, which is what "the terminal stays mounted" actually means.
  const bindingRef = useRef<TerminalSessionBinding | null>(null);
  const [paneState, setPaneState] = useState<PaneState>({ type: "loading" });
  const [lostScrollback, setLostScrollback] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [atTopOfScrollback, setAtTopOfScrollback] = useState(false);
  // The live-terminal dock (chat v2 §1): true while the chat has unveiled the
  // bottom slice of this pane's real terminal. Owned here because the pane is
  // what shrinks the overlay and frames the slice.
  const [dockRevealed, setDockRevealed] = useState(false);
  const dependencies = props.dependencies ?? defaultDependencies;
  // Ref-isolated so a new callback identity never re-runs the bootstrap
  // effect (which would tear down and remount the whole terminal).
  const onCwdRef = useRef(props.onCwd);
  onCwdRef.current = props.onCwd;
  const onOutputRef = useRef(props.onOutput);
  onOutputRef.current = props.onOutput;
  const onCaptureRef = useRef(props.onConversationCaptured);
  onCaptureRef.current = props.onConversationCaptured;
  // Read at attach time only: a dims change must not remount the terminal.
  const recordedDimsRef = useRef(props.recordedDims);
  recordedDimsRef.current = props.recordedDims;

  // Leaving chat mode retires the dock: flipping back must start clean, not
  // resurrect a slice the reveal controller no longer knows about.
  const chatMode = props.chat?.mode;
  useEffect(() => {
    if (chatMode !== "chat") {
      setDockRevealed(false);
    }
  }, [chatMode]);

  // The dock swaps who owns the keyboard (chat v2 §3): revealed, the real
  // terminal takes every keystroke; hidden, the chat's box takes them back.
  // The xterm is also pinned to its bottom — that is where claude draws its
  // input box and menus, and the whole point of the slice.
  useEffect(() => {
    const element = containerRef.current;
    const pane = element?.closest(".terminal-pane");
    if (chatMode !== "chat" || !element || !pane) {
      return;
    }
    if (dockRevealed) {
      const viewport = element.querySelector(".xterm-viewport");
      if (viewport instanceof HTMLElement) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      element.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    } else {
      pane.querySelector<HTMLTextAreaElement>(".chat-input__box")?.focus();
    }
  }, [dockRevealed, chatMode]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    let cancelled = false;
    let binding: TerminalSessionBinding | null = null;
    let ownedClient: PaneHostClient | null = null;
    let stopHostErrors: () => void = () => undefined;
    let stopObserving: () => void = () => undefined;
    let stopJumpListener: () => void = () => undefined;
    let presentation: TerminalPresentation;
    let linkActivationId = 0;
    const inputMarks = new InputMarks();
    let stopScrollListener: () => void = () => undefined;
    setPaneState({ type: "loading" });
    setLostScrollback(false);
    setLinkNotice(null);
    setAtTopOfScrollback(false);

    const onLink = (link: string) => {
      const activationId = ++linkActivationId;
      setLinkNotice(null);
      void dependencies.activateLink(link).then(
        (message) => {
          if (!cancelled && activationId === linkActivationId) {
            setLinkNotice(message);
          }
        },
        () => {
          if (!cancelled && activationId === linkActivationId) {
            setLinkNotice("The link action failed.");
          }
        },
      );
    };

    try {
      presentation = dependencies.createPresentation(element, onLink);
    } catch (error) {
      setPaneState({ type: "error", message: safeErrorMessage(error) });
      return;
    }
    presentationRef.current = presentation;
    stopScrollListener = presentation.onScroll?.((atTop) => {
      if (!cancelled) {
        setAtTopOfScrollback(atTop);
      }
    }) ?? (() => undefined);

    const reportStatus = (status: TerminalSessionStatus) => {
      if (cancelled) {
        return;
      }
      switch (status.type) {
        case "attached":
          setPaneState({ type: "ready" });
          return;
        case "lost_scrollback":
          setLostScrollback(true);
          return;
        case "exited":
          setPaneState({ type: "exited", exitCode: status.exitCode });
          return;
        case "disconnected":
          setPaneState({ type: "disconnected" });
          return;
        case "error":
          setPaneState({
            type: "runtime_error",
            message:
              status.operation === "host"
                ? `Terminal host error: ${status.message}`
                : `Terminal ${status.operation} failed: ${status.message}`,
          });
      }
    };

    void (async () => {
      try {
        const supplied = props.client
          ? { client: props.client, sessionId: props.sessionId }
          : await dependencies.bootstrapSession();
        if (cancelled) {
          if (!props.client) {
            attemptCleanup("host_client", () => supplied.client.close());
          }
          return;
        }
        if (!props.client) {
          ownedClient = supplied.client;
        }

        stopHostErrors = supplied.client.onError((error) => {
          if (binding) {
            binding.reportHostError(error);
          } else if (!cancelled) {
            setPaneState({
              type: "runtime_error",
              message: `Terminal host error: ${safeErrorMessage(error)}`,
            });
          }
        });
        // Replay has to land in a terminal shaped exactly as the host recorded
        // it; replaying into a differently sized grid is what garbles TUIs
        // (spec §13). Fit-to-container is deferred until replay finishes so a
        // full-screen app receives ONE clean resize and redraws itself.
        const recordedDims = normalizeDimensions(recordedDimsRef.current);
        const sizedToRecord =
          recordedDims !== null && applyRecordedDimensions(presentation, recordedDims);
        let replayFinished = false;
        let attachResolved = false;
        let postReplayFitDone = false;
        // The single fit + host resize the recorded-dims path is allowed to
        // run: after replay AND after the binding owns the attachment (only
        // then can the resize reach the host). Runs exactly once.
        const fitAfterReplay = () => {
          if (postReplayFitDone || cancelled || !replayFinished || !attachResolved) {
            return;
          }
          postReplayFitDone = true;
          binding?.fitAndResize();
        };

        binding = new TerminalSessionBinding({
          client: supplied.client,
          sessionId: supplied.sessionId,
          terminal: presentation.terminal,
          fit: presentation.fit,
          onStatus: reportStatus,
          onCleanupError: reportCleanupError,
          onCwd: (path, live) => onCwdRef.current?.(path, live),
          onOutputRegistered: (path) => onOutputRef.current?.(path),
          onConversationCaptured: (capture) =>
            onCaptureRef.current?.(supplied.sessionId, capture),
          onUserInput: (data) =>
            inputMarks.onUserInput(data, () => presentation.registerInputMarker()),
          onReplayFinished: () => {
            replayFinished = true;
            // Only the recorded-dims path defers its fit; without dims the
            // pane keeps its original fit-after-attach behaviour exactly.
            if (sizedToRecord) {
              fitAfterReplay();
            }
          },
        });
        const onJumpToLastInput = (event: Event) => {
          const detail = (event as CustomEvent<{ sessionId?: number }>).detail;
          if (detail?.sessionId !== supplied.sessionId) {
            return;
          }
          const line = inputMarks.jumpPrevious(presentation.viewportY());
          if (line !== null) {
            presentation.scrollToLine(line);
          }
        };
        window.addEventListener("termx:jump-last-input", onJumpToLastInput);
        stopJumpListener = () =>
          window.removeEventListener("termx:jump-last-input", onJumpToLastInput);
        const activeBinding = binding;
        bindingRef.current = activeBinding;
        stopObserving = dependencies.observeResize(element, () => {
          if (sizedToRecord && !replayFinished) {
            // Never retarget the grid mid-replay; the post-replay fit reads
            // the container's final size anyway.
            return;
          }
          activeBinding.fitAndResize();
        });
        await activeBinding.start();
        if (cancelled) {
          return;
        }
        attachResolved = true;
        if (sizedToRecord) {
          // A resolved attach means the host delivered the whole replay. If no
          // live frame closed it, close it here so the post-replay fit runs.
          activeBinding.markReplayBoundary();
          fitAfterReplay();
        } else {
          activeBinding.fitAndResize();
        }
        presentation.focus();
      } catch (error) {
        attemptCleanup("resize_observer", stopObserving);
        stopObserving = () => undefined;
        attemptCleanup("host_error_subscription", stopHostErrors);
        stopHostErrors = () => undefined;
        attemptCleanup("terminal_attachment", () => binding?.dispose());
        binding = null;
        attemptCleanup("host_client", () => ownedClient?.close());
        ownedClient = null;
        if (!cancelled) {
          setPaneState({ type: "error", message: safeErrorMessage(error) });
        }
      }
    })();

    return () => {
      cancelled = true;
      attemptCleanup("scroll_listener", stopScrollListener);
      attemptCleanup("jump_listener", stopJumpListener);
      attemptCleanup("input_marks", () => inputMarks.dispose());
      attemptCleanup("resize_observer", stopObserving);
      attemptCleanup("host_error_subscription", stopHostErrors);
      attemptCleanup("terminal_attachment", () => binding?.dispose());
      if (bindingRef.current === binding) {
        bindingRef.current = null;
      }
      attemptCleanup("host_client", () => ownedClient?.close());
      attemptCleanup("terminal_presentation", () => presentation.dispose());
      if (presentationRef.current === presentation) {
        presentationRef.current = null;
      }
    };
    // `attachGeneration` belongs here on purpose: a reconnect gives the hub a
    // NEW host attachment, and the old binding is unrecoverable (its
    // `onDisconnect` already ended input). Rebuilding the terminal is what
    // makes the pane usable again — the alternative is a live session the user
    // can only stare at until they restart the app.
  }, [dependencies, props.client, props.sessionId, props.attachGeneration]);

  // Live theme switching: the pane owns no theme state, it just forwards the
  // new palette to whatever presentation is mounted right now.
  useEffect(
    () =>
      onThemeChange((themeId) => {
        presentationRef.current?.setTheme?.(xtermTheme(themeById(themeId)));
      }),
    [],
  );

  const runSearch = (direction: "next" | "previous") => {
    if (searchQuery.length === 0) {
      return;
    }
    const presentation = presentationRef.current;
    if (direction === "next") {
      presentation?.findNext(searchQuery);
    } else {
      presentation?.findPrevious(searchQuery);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    presentationRef.current?.focus();
  };

  // How much of the pane the dock claims while revealed. A percentage keeps it
  // proportional across pane sizes without any resize listener.
  const dockHeight =
    props.chat?.mode === "chat" && dockRevealed ? "42%" : "0px";

  return (
    <section
      className="terminal-pane"
      data-testid="terminal-pane"
      aria-label="Terminal session"
      style={{ "--chat-dock": dockHeight } as React.CSSProperties}
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
        }
      }}
    >
      <div className="terminal-pane__surface" ref={containerRef} />

      {/* The chat renders OVER the terminal — the surface above stays mounted
          and attached, which is what keeps the session running and gives the
          prompt detector something to read. When the dock reveals, the overlay
          lifts its bottom edge (--chat-dock, set on the pane root) and the
          terminal's own bottom rows show through — claude's REAL input box and
          menus, framed below (chat v2 §1). */}
      {props.chat && props.chat.mode === "chat" ? (
        <ChatOverlay
          filePath={props.chat.filePath}
          density={props.chat.density}
          onDensityChange={props.chat.onDensityChange}
          showThinking={props.chat.showThinking}
          onShowThinkingChange={props.chat.onShowThinkingChange}
          sendKeys={(data) => bindingRef.current?.sendInput(data)}
          terminalSnapshot={() => presentationRef.current?.visibleLines?.() ?? []}
          {...(props.chat.bootReveal ? { bootReveal: true } : {})}
          onRevealChange={(state) => setDockRevealed(state.revealed)}
          header={{
            title: props.chat.title,
            onFlipToTerminal: () => props.chat?.onModeChange("terminal"),
            ...(props.chat.model ? { model: props.chat.model } : {}),
            ...(props.chat.onOpenLinkPicker
              ? { onOpenLinkPicker: props.chat.onOpenLinkPicker }
              : {}),
          }}
          {...(props.chat.openFeed ? { openFeed: props.chat.openFeed } : {})}
        />
      ) : null}

      {props.chat && props.chat.mode === "chat" && dockRevealed ? (
        <div className="terminal-pane__dock" data-testid="chat-dock" aria-hidden="true">
          <span className="terminal-pane__dock-caption">live · claude</span>
        </div>
      ) : null}

      {props.chat && props.chat.mode === "terminal" ? (
        <button
          type="button"
          className="terminal-pane__chat-switch"
          data-testid="chat-switch"
          title="Show this session as a chat (Ctrl+Shift+A)"
          onClick={() => props.chat?.onModeChange("chat")}
        >
          Chat
        </button>
      ) : null}

      {/* Only at the top of the scrollback, and only when the ring has actually
          evicted something: an always-visible bar in every pane would be noise
          for the many sessions that never outgrow their ring. */}
      {atTopOfScrollback && (props.historyBefore ?? 0n) > 0n && props.onLoadEarlier ? (
        <button
          type="button"
          className="terminal-pane__load-earlier"
          data-testid="load-earlier-output"
          onClick={() => props.onLoadEarlier?.(props.historyBefore ?? 0n)}
        >
          Load earlier output
        </button>
      ) : null}

      {searchOpen ? (
        <div className="terminal-search" role="search">
          <input
            aria-label="Search terminal output"
            autoFocus
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
              }
            }}
            placeholder="Find in terminal"
          />
          <button type="button" aria-label="Previous match" onClick={() => runSearch("previous")}>
            ↑
          </button>
          <button type="button" aria-label="Next match" onClick={() => runSearch("next")}>
            ↓
          </button>
          <button type="button" aria-label="Close search" onClick={closeSearch}>
            ×
          </button>
        </div>
      ) : null}

      {linkNotice ? (
        <div className="terminal-pane__link-notice" role="status">
          {linkNotice}
        </div>
      ) : null}
      {lostScrollback ? (
        <div className="terminal-pane__notice" role="status">
          Earlier output is no longer available.
        </div>
      ) : null}
      {props.suspended ? (
        <div
          className="terminal-pane__chip terminal-pane__chip--reconnecting"
          data-testid="pane-reconnecting-chip"
          role="status"
        >
          Reconnecting…
        </div>
      ) : null}
      {/* While the chip is up the outage is already stated; the status line
          would only say the same thing twice, in gloomier words. */}
      {paneState.type !== "ready"
      && paneState.type !== "loading"
      && !(props.suspended && paneState.type === "disconnected") ? (
        <div className={`terminal-pane__status terminal-pane__status--${paneState.type}`} role="status">
          {statusText(paneState)}
        </div>
      ) : null}
      {paneState.type === "loading" ? (
        <div className="terminal-pane__loading" role="status">
          Connecting…
        </div>
      ) : null}
    </section>
  );
}

async function bootstrapFirstSession(): Promise<{ client: PaneHostClient; sessionId: number }> {
  const bootstrap = parseBootstrapResult(await invoke<unknown>("bootstrap_host"));
  const client = await HostClient.connect(bootstrap);
  try {
    const existing = client.initialSessions.find((session) => session.alive);
    if (existing) {
      return { client, sessionId: existing.id };
    }

    const created = await client.createSession({
      profile: null,
      cwd: null,
      cols: 80,
      rows: 24,
    });
    return { client, sessionId: created.id };
  } catch (error) {
    client.close();
    throw error;
  }
}

function parseBootstrapResult(value: unknown): { port: number; token: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("port" in value) ||
    !("token" in value) ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    typeof value.token !== "string" ||
    value.token.length === 0
  ) {
    throw new Error("Native host bootstrap returned an invalid result");
  }
  return { port: value.port as number, token: value.token };
}

function createPresentation(
  element: HTMLElement,
  onLink: (link: string) => void,
): TerminalPresentation {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
    fontSize: 14,
    scrollback: 10_000,
    windowsPty: { backend: "conpty" },
    theme: xtermTheme(themeById(currentThemeId())),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const openLink = (_event: MouseEvent, link: string) => onLink(link);
  try {
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon(openLink));
    // The addon appends its own "g" when compiling urlRegex; passing the
    // exported global regex through produced invalid "gg" flags and threw on
    // every hover, so hand it a flagless copy.
    terminal.loadAddon(
      new WebLinksAddon(openLink, { urlRegex: new RegExp(PATH_LINK_REGEX.source) }),
    );
    terminal.open(element);
    fit.fit();
  } catch (error) {
    attemptCleanup("partial_terminal_presentation", () => terminal.dispose());
    throw error;
  }

  // Copy is a first-class terminal action (Warp / Windows Terminal manners):
  // Ctrl+Shift+C always copies the selection, and plain Ctrl+C copies when a
  // selection is active INSTEAD of interrupting — with nothing selected it
  // stays the interrupt it has always been. xterm's selection is not DOM
  // selection, so without this there is no way to copy at all.
  const copySelection = (): boolean => {
    const text = terminal.getSelection();
    if (text.length === 0) {
      return false;
    }
    void navigator.clipboard?.writeText?.(text).catch(() => undefined);
    terminal.clearSelection();
    return true;
  };
  terminal.attachCustomKeyEventHandler((event) => {
    if (
      event.type !== "keydown" ||
      !event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.key.toLowerCase() !== "c"
    ) {
      return true;
    }
    if (!copySelection()) {
      return true;
    }
    event.preventDefault();
    return false;
  });
  // Right-click with a selection copies it too; without one the native menu
  // stays (it is how paste is reachable by mouse).
  const onContextMenu = (event: MouseEvent) => {
    if (terminal.hasSelection() && copySelection()) {
      event.preventDefault();
    }
  };
  element.addEventListener("contextmenu", onContextMenu);

  // Read per search, not captured once: a theme switch must reach the next
  // highlight too.
  const searchOptions = () => ({
    decorations: xtermSearchDecorations(themeById(currentThemeId())),
  });

  const port: TerminalPort = {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    parser: terminal.parser,
    onData: (listener) => terminal.onData(listener),
    reset: () => terminal.reset(),
    write: (data, callback) => terminal.write(data, callback),
    reassertWindowsPtyInputMode: () => {
      // ConPTY's win32-input-mode toggle may be stale or evicted from the
      // replayed ring — never depend on it (replay-hazard memo).
      terminal.options.windowsPty = { backend: "conpty" };
      terminal.write("\x1b[?9001h");
    },
  };

  return {
    terminal: port,
    fit: () => fit.fit(),
    resize: (cols, rows) => terminal.resize(cols, rows),
    setTheme: (palette) => {
      terminal.options.theme = palette;
    },
    findNext: (query) => search.findNext(query, searchOptions()),
    findPrevious: (query) => search.findPrevious(query, searchOptions()),
    focus: () => terminal.focus(),
    dispose: () => {
      element.removeEventListener("contextmenu", onContextMenu);
      terminal.dispose();
    },
    registerInputMarker: () => {
      if (terminal.buffer.active.type === "alternate") {
        return undefined;
      }
      return terminal.registerMarker(0) ?? undefined;
    },
    scrollToLine: (line) => terminal.scrollToLine(line),
    viewportY: () => terminal.buffer.active.viewportY,
    visibleLines: () => {
      const buffer = terminal.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < terminal.rows; row += 1) {
        // `true` trims the right padding, which is what makes a drawn dialog
        // read as the lines someone would see rather than a grid of spaces.
        rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
      }
      return rows;
    },
    onScroll: (listener) => {
      const subscription = terminal.onScroll(() => {
        // baseY 0 means nothing has scrolled off yet — being "at the top" of a
        // scrollback that does not exist is not an invitation to load more.
        const buffer = terminal.buffer.active;
        listener(buffer.baseY > 0 && buffer.viewportY === 0);
      });
      return () => subscription.dispose();
    },
  };
}

/** Host dims are u16 on the wire; anything else is treated as unknown. */
function normalizeDimensions(
  value: TerminalDimensions | null | undefined,
): TerminalDimensions | null {
  if (!value) {
    return null;
  }
  const cols = Math.trunc(value.cols);
  const rows = Math.trunc(value.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
    return null;
  }
  return { cols, rows };
}

/**
 * Pre-size the terminal to the host-recorded dims. Returns false when the
 * presentation cannot be pre-sized, which keeps the pane on the legacy
 * fit-then-replay path rather than losing the terminal.
 */
function applyRecordedDimensions(
  presentation: TerminalPresentation,
  dimensions: TerminalDimensions,
): boolean {
  if (!presentation.resize) {
    return false;
  }
  try {
    presentation.resize(dimensions.cols, dimensions.rows);
    return true;
  } catch {
    return false;
  }
}

function observeResize(element: HTMLElement, listener: () => void): () => void {
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(listener);
    observer.observe(element);
    return () => observer.disconnect();
  }
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

export async function activateTerminalLink(link: string): Promise<string | null> {
  if (/^https?:\/\//i.test(link)) {
    window.open(link, "_blank", "noopener,noreferrer");
    return "Link sent to the browser.";
  }

  const event = new CustomEvent("termx:open-path", {
    cancelable: true,
    detail: { path: link },
  });
  if (!window.dispatchEvent(event)) {
    return "Opening path…";
  }
  if (!navigator.clipboard?.writeText) {
    return "No path opener is available.";
  }
  try {
    await navigator.clipboard.writeText(link);
    return "Path copied to clipboard.";
  } catch {
    return "The path could not be copied.";
  }
}

function attemptCleanup(operation: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    reportCleanupError(operation);
  }
}

function reportCleanupError(operation: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("termx:terminal-cleanup-error", {
        detail: { operation },
      }),
    );
  } catch {
    // The window itself is already tearing down; no reporting channel remains.
  }
}

function statusText(state: Exclude<PaneState, { type: "loading" | "ready" }>): string {
  switch (state.type) {
    case "error":
      return `Unable to open terminal: ${state.message}`;
    case "runtime_error":
      return state.message;
    case "exited":
      return state.exitCode === null
        ? "Session exited"
        : `Session exited with code ${state.exitCode}`;
    case "disconnected":
      return "Host connection lost. The session may still be running.";
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected terminal error";
}
