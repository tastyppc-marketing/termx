/**
 * The viewer's controller (spec §12): it owns what is open, exposes the
 * imperative `ViewerApi` the rest of the app opens things through, and turns
 * surface changes into `onGeometry` callbacks. It persists nothing itself —
 * geometry lives in `ui_state_v1.json`, written by whoever mounts this.
 *
 * `readFile` is INJECTED rather than imported: the component never touches
 * `invoke`, so tests drive it with a plain fake and the Tauri command
 * (`read_text_file`, which already answers `{ content, truncated } | null`)
 * stays a wiring detail of the App.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { fileName, FileView, Viewer, type FileReadResult } from "./Viewer";
import {
  transitionViewerGeometry,
  type ViewerGeometry,
  type ViewerGeometryEvent,
} from "./viewerState";

export type { FileReadResult } from "./Viewer";

/**
 * A session as the host serializes it (`SessionRecord`, camelCase over IPC).
 * `provider` stays a plain string so any record coming from the conversations
 * layer assigns without a cast.
 */
export interface LlmSessionRecord {
  provider: string;
  id: string;
  title: string;
  cwd: string | null;
  filePath: string;
  updatedAtMs: number;
  summary: string | null;
  recap: string | null;
}

/* -------------------------------------------------------------------------
 * Transcript mount seam (filled by U14)
 *
 * Contract, in three parts:
 *  1. U14 creates `ui/src/viewer/transcript/TranscriptView.tsx` exporting a
 *     named `TranscriptView: ComponentType<TranscriptViewProps>`.
 *  2. This module discovers that file through `import.meta.glob`, which is
 *     lazy (its own chunk, loaded on first `openTranscript`) and — unlike a
 *     bare `import()` of a path that does not exist yet — resolves to an
 *     EMPTY map instead of failing the build while the file is absent.
 *  3. Until then, or if loading fails for any reason, the body renders the
 *     stub. A missing transcript module is a normal state, never an error.
 *
 * `registerTranscript` overrides the discovery for tests and for callers that
 * want to supply the module themselves; it is the same `() => Promise<module>`
 * shape.
 * ---------------------------------------------------------------------- */

export interface TranscriptViewProps {
  record: LlmSessionRecord;
}

export interface TranscriptModule {
  TranscriptView: ComponentType<TranscriptViewProps>;
}

export type TranscriptLoader = () => Promise<TranscriptModule>;

const TRANSCRIPT_MODULE_PATH = "./transcript/TranscriptView.tsx";

const transcriptModules = import.meta.glob<TranscriptModule>(
  "./transcript/TranscriptView.tsx",
);

function discoverTranscriptLoader(): TranscriptLoader | null {
  return transcriptModules[TRANSCRIPT_MODULE_PATH] ?? null;
}

export interface ViewerApi {
  openFile(path: string): void;
  openTranscript(record: LlmSessionRecord): void;
  close(): void;
}

export interface ViewerHostProps {
  readFile(path: string): Promise<FileReadResult | null>;
  geometry: ViewerGeometry;
  onGeometry(geometry: ViewerGeometry): void;
  registerTranscript?: TranscriptLoader;
}

type ViewerContent =
  | { kind: "file"; path: string; result: FileReadResult | null | undefined }
  | {
      kind: "transcript";
      record: LlmSessionRecord;
      view: ComponentType<TranscriptViewProps> | null;
    };

export const ViewerHost = forwardRef<ViewerApi, ViewerHostProps>(
  function ViewerHost(
    { readFile, geometry, onGeometry, registerTranscript },
    ref,
  ) {
    const [content, setContent] = useState<ViewerContent | null>(null);
    // Monotonic: a slow read for a file the user already navigated away from
    // must not replace what is on screen.
    const requestId = useRef(0);

    const applyGeometry = useCallback(
      (event: ViewerGeometryEvent): void => {
        const next = transitionViewerGeometry(geometry, event);
        if (next !== geometry) {
          onGeometry(next);
        }
      },
      [geometry, onGeometry],
    );

    const closeViewer = useCallback((): void => {
      // Bump the request id so an in-flight read cannot re-open what the user
      // just closed.
      requestId.current += 1;
      setContent(null);
      applyGeometry({ type: "close" });
    }, [applyGeometry]);

    const visible = geometry.state === "docked" || geometry.state === "overlay";

    // Window-level, and only while something readable is on screen: the
    // shortcut must not fight the terminal when the viewer is closed or
    // minimized (spec §12).
    useEffect(() => {
      if (!visible || content === null) {
        return;
      }
      const handleKeyDown = (event: KeyboardEvent): void => {
        if (
          event.ctrlKey &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === "m"
        ) {
          event.preventDefault();
          applyGeometry({ type: "toggle-overlay" });
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [applyGeometry, content, visible]);

    useImperativeHandle(
      ref,
      () => ({
        openFile(path: string) {
          const request = ++requestId.current;
          setContent({ kind: "file", path, result: undefined });
          applyGeometry({ type: "show" });
          void readFile(path)
            .catch(() => null)
            .then((result) => {
              if (requestId.current === request) {
                setContent({ kind: "file", path, result });
              }
            });
        },
        openTranscript(record: LlmSessionRecord) {
          const request = ++requestId.current;
          setContent({ kind: "transcript", record, view: null });
          applyGeometry({ type: "show" });
          const load = registerTranscript ?? discoverTranscriptLoader();
          if (!load) {
            return;
          }
          void Promise.resolve()
            .then(load)
            .then((module) => {
              if (requestId.current === request && module?.TranscriptView) {
                setContent({
                  kind: "transcript",
                  record,
                  view: module.TranscriptView,
                });
              }
            })
            .catch(() => {
              // Module absent or broken: the stub is already showing.
            });
        },
        close: closeViewer,
      }),
      [applyGeometry, closeViewer, readFile, registerTranscript],
    );

    if (content === null) {
      return null;
    }

    const label =
      content.kind === "file" ? fileName(content.path) : content.record.title;
    const detail =
      content.kind === "file" ? content.path : content.record.filePath;
    const TranscriptBody = content.kind === "transcript" ? content.view : null;

    return (
      <Viewer
        label={label}
        detail={detail}
        geometry={geometry}
        onDock={(dock) => applyGeometry({ type: "dock", dock })}
        onToggleOverlay={() => applyGeometry({ type: "toggle-overlay" })}
        onMinimize={() => applyGeometry({ type: "minimize" })}
        onRestore={() => applyGeometry({ type: "restore" })}
        onClose={closeViewer}
        onResize={(sizePx) => applyGeometry({ type: "resize", sizePx })}
      >
        {content.kind === "file" ? (
          <FileView path={content.path} result={content.result} />
        ) : TranscriptBody ? (
          <TranscriptBody record={content.record} />
        ) : (
          <p className="viewer__transcript-fallback">
            Transcript mode goes here
          </p>
        )}
      </Viewer>
    );
  },
);
