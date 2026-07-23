import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { HostClient } from "../host/client";
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

export interface TerminalPresentation {
  terminal: TerminalPort;
  fit(): void;
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  focus(): void;
  dispose(): void;
}

export interface TerminalPaneDependencies {
  bootstrapSession(): Promise<{ client: PaneHostClient; sessionId: number }>;
  createPresentation(element: HTMLElement, onLink: (link: string) => void): TerminalPresentation;
  observeResize(element: HTMLElement, listener: () => void): () => void;
  activateLink(link: string): Promise<string | null>;
}

type TerminalPaneProps =
  | {
      client?: undefined;
      sessionId?: undefined;
      dependencies?: TerminalPaneDependencies;
    }
  | {
      client: PaneHostClient;
      sessionId: number;
      dependencies?: TerminalPaneDependencies;
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
  const [paneState, setPaneState] = useState<PaneState>({ type: "loading" });
  const [lostScrollback, setLostScrollback] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const dependencies = props.dependencies ?? defaultDependencies;

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
    let presentation: TerminalPresentation;
    let linkActivationId = 0;
    setPaneState({ type: "loading" });
    setLostScrollback(false);
    setLinkNotice(null);

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
        binding = new TerminalSessionBinding({
          client: supplied.client,
          sessionId: supplied.sessionId,
          terminal: presentation.terminal,
          fit: presentation.fit,
          onStatus: reportStatus,
          onCleanupError: reportCleanupError,
        });
        const activeBinding = binding;
        stopObserving = dependencies.observeResize(element, () => activeBinding.fitAndResize());
        await activeBinding.start();
        if (cancelled) {
          return;
        }
        activeBinding.fitAndResize();
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
      attemptCleanup("resize_observer", stopObserving);
      attemptCleanup("host_error_subscription", stopHostErrors);
      attemptCleanup("terminal_attachment", () => binding?.dispose());
      attemptCleanup("host_client", () => ownedClient?.close());
      attemptCleanup("terminal_presentation", () => presentation.dispose());
      if (presentationRef.current === presentation) {
        presentationRef.current = null;
      }
    };
  }, [dependencies, props.client, props.sessionId]);

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

  return (
    <section
      className="terminal-pane"
      data-testid="terminal-pane"
      aria-label="Terminal session"
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
        }
      }}
    >
      <div className="terminal-pane__surface" ref={containerRef} />

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
      {paneState.type !== "ready" && paneState.type !== "loading" ? (
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
    theme: {
      background: "#0f1115",
      foreground: "#e6e6e6",
      cursor: "#7aa2f7",
      selectionBackground: "#334155",
    },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const openLink = (_event: MouseEvent, link: string) => onLink(link);
  try {
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon(openLink));
    terminal.loadAddon(new WebLinksAddon(openLink, { urlRegex: PATH_LINK_REGEX }));
    terminal.open(element);
    fit.fit();
  } catch (error) {
    attemptCleanup("partial_terminal_presentation", () => terminal.dispose());
    throw error;
  }

  const searchOptions = {
    decorations: {
      matchBackground: "#463f24",
      matchOverviewRuler: "#d4a72c",
      activeMatchBackground: "#7c5c18",
      activeMatchColorOverviewRuler: "#f0c36a",
    },
  };

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
    findNext: (query) => search.findNext(query, searchOptions),
    findPrevious: (query) => search.findPrevious(query, searchOptions),
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
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
