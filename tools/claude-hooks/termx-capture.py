"""TermX conversation capture: a Claude Code SessionStart hook.

WHY. A dead TermX pane offers "Resume conversation", and until now it chose by
folder: the NEWEST conversation recorded in the pane's directory. That guesses,
and it guesses wrong exactly where it matters -- three panes open in one repo
all resume the same conversation, and a pane whose directory was never recorded
gets no resume at all. This hook records the real pairing at the source: when
Claude Code starts inside a TermX pane, one line says which conversation that
pane is running.

CONTRACT. Claude Code runs this on SessionStart (matcher
"startup|resume|clear|compact") with the hook payload as JSON on stdin:
`{ session_id, cwd, transcript_path, hook_event_name, source }`. If
TERMX_SESSION_ID is absent, Claude is not running in a TermX pane and there is
nothing to pair -- exit silently. Otherwise append ONE line to
`<data dir>\\conversation_captures_v1.jsonl`:

    {"v":1,"termxSessionId":3,"provider":"claude","id":"<session_id>",
     "cwd":"<cwd>","atMs":1756600000000}

RULES this file will not break:
  * It NEVER prints. stdout from a SessionStart hook is injected into Claude's
    context; stderr is noise in the user's face. Silence is the interface.
  * It NEVER raises. A hook that fails must not colour a session's startup, so
    every failure path -- unreadable stdin, unset APPDATA, a locked file --
    ends in exit code 0 with nothing written.
  * It validates `session_id` against ^[A-Za-z0-9-]+$ before writing, the same
    rule ui/src/conversations/resume.ts enforces, because that id is later
    typed onto a command line as `claude --resume <id>`. An id that could not
    be resumed is not worth recording.

The file is append-only and the UI dedupes it (newest atMs per TermX session
id wins), so a single line per Claude start is all the coordination there is --
no read-modify-write, nothing to corrupt if two panes start at once.

INSTALLATION (the orchestrator does this, not this script): add to
`~/.claude/settings.json`, keeping a dated backup of the file first --

    "hooks": {
      "SessionStart": [
        { "matcher": "startup|resume|clear|compact",
          "hooks": [ { "type": "command",
                       "command": "python \\"<TermX repo>\\\\tools\\\\claude-hooks\\\\termx-capture.py\\"" } ] }
      ]
    }

That settings entry is the one place an absolute path to this repo is allowed:
settings.json is user configuration, not code.

DATA DIR. `%TERMX_DATA_DIR%` when set (the portable layout resolves its own
data folder beside the exe and can export it), else `%APPDATA%\\TermX` -- the
same default ui/src-tauri/src/paths.rs resolves. Nothing is hardcoded.
"""

import json
import os
import re
import sys
import time

CAPTURES_FILE = "conversation_captures_v1.jsonl"
SESSION_ENV = "TERMX_SESSION_ID"
DATA_DIR_ENV = "TERMX_DATA_DIR"
# Same rule as RESUME_ID_PATTERN in ui/src/conversations/resume.ts.
ID_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")


def data_dir():
    """The TermX data directory, or None when it cannot be resolved."""
    override = os.environ.get(DATA_DIR_ENV)
    if override:
        return override
    appdata = os.environ.get("APPDATA")
    if appdata:
        return os.path.join(appdata, "TermX")
    # Non-Windows hosts have no APPDATA; TermX itself is Windows-only today, so
    # this is only ever reached by a stray hook run and writes nothing.
    return None


def termx_session_id():
    """The pane's host session id as an int, or None when not in a pane."""
    raw = os.environ.get(SESSION_ENV)
    if not raw:
        return None
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def capture_line(payload, session_id):
    """The JSON line to append, or None when the payload is not capturable."""
    conversation_id = payload.get("session_id")
    if not isinstance(conversation_id, str) or not ID_PATTERN.match(conversation_id):
        return None
    cwd = payload.get("cwd")
    record = {
        "v": 1,
        "termxSessionId": session_id,
        "provider": "claude",
        "id": conversation_id,
        "cwd": cwd if isinstance(cwd, str) and cwd else None,
        "atMs": int(time.time() * 1000),
    }
    # ensure_ascii keeps the line to one byte per character for a non-ASCII
    # path, so an append can never interleave a partial multi-byte sequence.
    return json.dumps(record, ensure_ascii=True, separators=(",", ":"))


def main():
    session_id = termx_session_id()
    if session_id is None:
        return
    directory = data_dir()
    if directory is None:
        return
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return
    if not isinstance(payload, dict):
        return
    line = capture_line(payload, session_id)
    if line is None:
        return
    os.makedirs(directory, exist_ok=True)
    # One write of one short line in append mode: the OS appends it whole, so
    # concurrent panes cannot interleave halves of two captures.
    with open(os.path.join(directory, CAPTURES_FILE), "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


if __name__ == "__main__":
    try:
        main()
    except BaseException:  # noqa: BLE001 - a hook must never fail a session
        pass
    sys.exit(0)
