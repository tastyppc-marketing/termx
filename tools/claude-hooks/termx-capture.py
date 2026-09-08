"""TermX conversation capture: a Claude Code SessionStart hook.

WHY. A dead TermX pane offers "Resume conversation", and until now it chose by
folder: the NEWEST conversation recorded in the pane's directory. That guesses,
and it guesses wrong exactly where it matters -- three panes open in one repo
all resume the same conversation, and a pane whose directory was never recorded
gets no resume at all. This hook records the real pairing at the source: when
Claude Code starts inside a TermX pane, one line says which conversation that
pane is running.

CONTRACT. Claude Code runs this on SessionStart (matcher
"startup|resume|clear") with the hook payload as JSON on stdin:
`{ session_id, cwd, transcript_path, hook_event_name, source }`. The
`compact` source is deliberately NOT matched: compaction continues the same
conversation under the same session id, so its line would repeat the one
`startup` (or `resume`) already wrote and only grow the log. If
TERMX_SESSION_ID is absent, Claude is not running in a TermX pane and there is
nothing to pair -- exit silently. Otherwise append ONE line to
`<data dir>\\conversation_captures_v1.jsonl`:

    {"v":1,"termxSessionId":3,"provider":"claude","id":"<session_id>",
     "cwd":"<cwd>","atMs":1756600000000}

RULES this file will not break:
  * It NEVER prints. stdout from a SessionStart hook is injected into Claude's
    context; stderr is noise in the user's face. Silence is the interface.
  * It NEVER raises. A hook that fails must not colour a session's startup, so
    every failure path -- unreadable stdin, bytes that are not UTF-8, unset
    APPDATA, a locked file -- ends in exit code 0 with nothing written.
  * It reads stdin as BYTES and decodes UTF-8 itself. Text mode would decode
    with the console's locale encoding, which on Windows is cp1252, and Claude
    Code (Node's JSON.stringify) writes raw UTF-8: a cwd holding CJK or an
    accent would be stored mojibaked, and the pane would later restart in a
    folder that does not exist. This source stays pure ASCII for the same
    reason -- a hook that must never fail does not gamble on source encoding.
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
        { "matcher": "startup|resume|clear",
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
import base64
import os
import re
import sys
import time

CAPTURES_FILE = "conversation_captures_v1.jsonl"
SESSION_ENV = "TERMX_SESSION_ID"
DATA_DIR_ENV = "TERMX_DATA_DIR"
# Same rule as RESUME_ID_PATTERN in ui/src/conversations/resume.ts.
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")


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
    # Both hook generations can be installed. The exact launch identity lets
    # the reader retain the richer native record without mistaking a genuinely
    # later resume of this conversation for a duplicate hook invocation.
    try:
        token = os.environ.get("TERMX_AGENT_LAUNCH", "")
        if 0 < len(token) <= 65536:
            stamp = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
            pid = stamp.get("launcherPid")
            created = stamp.get("launcherCreatedAt")
            if (stamp.get("provider") == "claude" and isinstance(pid, int)
                    and 0 < pid <= 0xffffffff and isinstance(created, str)
                    and created.isascii() and created.isdigit()
                    and 0 < len(created) <= 20 and 0 < int(created) <= 0xffffffffffffffff):
                record["launcherPid"] = pid
                record["launcherCreatedAt"] = created
    except (ValueError, TypeError, AttributeError):
        pass
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
    # BYTES, not text: `sys.stdin.read()` would decode with the console's
    # locale encoding (cp1252 on a default Windows box) while Claude Code
    # writes UTF-8, silently mojibaking every non-ASCII cwd. Decoding strictly
    # here means a payload that is not UTF-8 is not ours to guess at -- write
    # nothing rather than a wrong path.
    try:
        raw = sys.stdin.buffer.read()
    except (AttributeError, ValueError, OSError):
        return
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        return
    if not isinstance(payload, dict):
        return
    line = capture_line(payload, session_id)
    if line is None:
        return
    os.makedirs(directory, exist_ok=True)
    # One write of one short line in append mode: the OS appends it whole, so
    # concurrent panes cannot interleave halves of two captures.
    #
    # newline="" stops Windows text mode translating the "\n" into "\r\n". The
    # UI's boot compaction rewrites this file with bare "\n", and a log that
    # mixed both would be needlessly hard to diff and reason about. The parser
    # tolerates either, so this is about keeping the file honest, not correct.
    path = os.path.join(directory, CAPTURES_FILE)
    # Native capture/compaction takes this lock with Windows share_mode(0).
    # Keeping any handle open participates in that exclusion without another
    # locking protocol; parallel legacy appenders may coexist safely.
    deadline = time.monotonic() + 1.0
    while True:
        try:
            lock = open(os.path.join(directory, "conversation_captures_v1.lock"), "a+b")
            break
        except PermissionError:
            if time.monotonic() >= deadline:
                return
            time.sleep(0.02)
    with lock:
        with open(path, "a", encoding="utf-8", newline="") as handle:
            handle.write(line + "\n")


if __name__ == "__main__":
    try:
        main()
    except BaseException:  # noqa: BLE001 - a hook must never fail a session
        pass
    sys.exit(0)
