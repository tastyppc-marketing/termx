# Resume with original launch settings

TermX can retain the arguments used to start a local Claude or Codex conversation
and include those settings when resuming it. This covers model, effort/config
overrides, permission options, extra directories, tools, settings and plugin
arguments. Repeated options retain their order. The initial user prompt and old
conversation selector are not sent again.

New sessions use the native `termx-host` launcher. With shell integration on,
new PowerShell panes wrap `claude` and `codex`, and new cmd panes provide matching
macros. Existing aliases/functions/macros retain precedence. Explicit executable
paths, custom wrappers and shells started before the updated host can bypass
capture. The native helper launches a fixed provider with an argument array;
saved values are never evaluated as shell code.

After updating the binaries, reopen the UI for its new controls. Capture also
requires restarting the background host: after finishing active work, close
TermX with **Stop everything**, then reopen it and create new shell panes.
Closing with **Keep running** deliberately retains the old host and shells.

## Install the capture hooks

Build the updated host, then run from the repository root:

```powershell
cargo build -p termx-host
python tools/install-resume-capture.py --host-exe target/debug/termx-host.exe
```

For an installed build, supply that build's `termx-host.exe` path instead.
The installer preserves other settings/hooks, makes a dated byte-for-byte backup
before changing an existing file, and supports `--dry-run`. It honors
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`, or explicit `--claude-dir` / `--codex-dir`.

Codex requires review of a new hook through `/hooks`. TermX does not bypass this
review or change sandbox/approval settings to enable capture. Claude requires
the normal workspace trust for interactive hooks. The hooks are silent outside
a tracked TermX launch.

## Identity and persistence

The SessionStart hook supplies the actual conversation ID. Capture checks its
process ancestry against the specific native launcher; it does not guess from
timestamps or a shared project folder. Shared app-server processes that do not
descend from that launcher cannot provide this association and are left without
captured options. Nested or unrelated launches must not inherit another
conversation's settings.

The original configuration is stored separately from the latest pane capture,
in `conversation_launches_v1.jsonl` in TermX's data directory. Later bare resumes
and pane-capture compaction do not erase that baseline. Saved sessions also
retain a configuration snapshot. The original launch directory is used for the
provider process so relative paths and `--cd` retain their meaning.

Conversation-list resume, dead-pane resume, saved fresh restore and saved idle
restore use the same configuration handling. Reattaching to a busy/live agent
does not send a command. Unknown options or corrupt captured configuration
produce a refusal rather than silently launching with a subset of the settings.

Older conversations whose arguments were never captured retain the previous
resume behavior. Their full launch arguments cannot be reconstructed from a
transcript. Referenced settings files and inherited environment variables are
not frozen; their current contents still apply. SSH saves are separate from
local identities; this change does not add remote launch capture.

Provider interfaces checked against installed Codex 0.153.3 and Claude Code
2.1.261. Hook references: [Codex](https://learn.chatgpt.com/docs/hooks) and
[Claude Code](https://code.claude.com/docs/en/hooks).
