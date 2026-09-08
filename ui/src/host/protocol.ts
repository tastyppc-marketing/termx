export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SessionInfo {
  id: number;
  profile: string;
  cwd: string | null;
  cols: number;
  rows: number;
  alive: boolean;
  pid: number | null;
}

export type ClientMsg =
  | { type: "auth"; token: string }
  | {
    type: "create_session";
    profile: string | null;
    cwd: string | null;
    cols: number;
    rows: number;
    shell_integration: boolean;
  }
  /** `since_offset` is a resume cursor: replay only what this client has not
   * seen. Omitted means replay the whole ring (a first attach). */
  | { type: "attach"; session_id: number; replay: boolean; since_offset?: number }
  | { type: "detach"; session_id: number }
  | { type: "resize"; session_id: number; cols: number; rows: number }
  | { type: "close_session"; session_id: number }
  | { type: "list_sessions" }
  /** Is this session alive, and is anything running inside its shell? The
   * saved-resume flow chooses between reattach and type-in-place on the
   * answer. */
  | { type: "probe_session"; session_id: number }
  | { type: "change_directory"; session_id: number; expected_pid: number; prompt_id: string; cwd: string }
  | { type: "set_layout"; layout: JsonValue }
  | { type: "get_state" }
  /** Page backward through the spilled scrollback: the newest `max_bytes` that
   * end before `before_offset`. Absent history answers empty, never an error. */
  | {
    type: "read_history";
    session_id: number;
    before_offset: number;
    max_bytes: number;
  }
  | { type: "shutdown" };

export type HostMsg =
  | { type: "auth_ok"; version: string; sessions: SessionInfo[] }
  | { type: "auth_err"; reason: string }
  | { type: "session_created"; info: SessionInfo }
  | {
    type: "replay";
    session_id: number;
    start_offset: number;
    data_b64: string;
  }
  | {
    type: "session_exited";
    session_id: number;
    exit_code: number | null;
  }
  | { type: "session_closed"; session_id: number }
  | { type: "sessions"; sessions: SessionInfo[] }
  /** `busy` errs toward true: a probe that cannot see the process tree
   * reports an occupied shell, because the caller's safe move is to reattach
   * and type nothing. */
  | { type: "session_probe"; session_id: number; alive: boolean; busy: boolean; at_prompt?: boolean; prompt_id?: string | null }
  | { type: "directory_changed"; session_id: number; accepted: boolean }
  | { type: "layout_saved" }
  | { type: "state"; layout: JsonValue; sessions: SessionInfo[] }
  /** `at_start` means this slice reaches the oldest byte the host still has —
   * there is nothing older to ask for. */
  | {
    type: "history";
    session_id: number;
    start_offset: number;
    data_b64: string;
    at_start: boolean;
  }
  | { type: "error"; context: string; message: string };
