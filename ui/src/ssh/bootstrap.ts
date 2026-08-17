/**
 * The remote bootstrap: what TermX types into a fresh local shell to turn an
 * ordinary ssh session into a tracked one (ssh-sessions spec §2).
 *
 * NOTHING IS INSTALLED ON THE REMOTE. Everything the remote side needs is
 * carried in the connect command itself, base64-encoded into a temp rcfile that
 * deletes itself once bash has read it. That is what makes "one-click connect"
 * work on a box TermX has never seen — and what keeps a VPS from accumulating
 * TermX droppings.
 *
 * Two channels come back out of the remote shell:
 *  - OSC 9;9 on every prompt — the same cwd channel local shells use, so remote
 *    panes track their folder through the machinery that already existed.
 *  - OSC 9;78 once per agent launch — a TermX-private report of the exact
 *    conversation id, emitted by a background watcher that notices the new
 *    transcript file appear. Captured, never guessed (spec "Decisions").
 *
 * QUOTING: the payload is base64, whose alphabet contains no single quote, so
 * the outer `'…'` that ssh needs can never be closed early by anything the user
 * typed — not a folder with an apostrophe, not a hostile alias. Aliases are
 * additionally validated rather than escaped: an alias is a name, and anything
 * that is not one is a mistake worth refusing.
 *
 * REMOTE ASSUMPTIONS (spec §2, documented not polyfilled): bash, `mktemp`,
 * `base64`, `find`, `basename`, `seq`, `head` — i.e. bash plus coreutils.
 */

/** A config alias is a name; nothing else is ever interpolated into a command. */
const SAFE_ALIAS = /^[A-Za-z0-9._-]+$/;

/** How long the id watcher waits for a transcript to appear: 240 × 0.5s. */
const WATCH_TICKS = 240;

export interface SshBootstrapOptions {
  /** Absolute remote path to cd into after the shell is set up. */
  remoteCwd?: string;
}

/** Wrap for bash single quotes: the only escape is close-escape-reopen. */
function singleQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** base64 of the UTF-8 bytes — a remote folder may be named in any language. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The watcher-plus-exec wrapper for one provider. `local` appears only in the
 * function body: inside the `( … )` subshell it is a syntax error on every
 * iteration, which would break the capture silently — hence plain variables
 * there (and a test that keeps it that way).
 *
 * The watcher runs detached and writes to /dev/tty rather than stdout, so the
 * OSC never lands in the middle of what claude is drawing, and stays invisible
 * to anything piping the agent's output.
 */
function providerWrapper(provider: "claude" | "codex", transcriptDir: string): string {
  return [
    `${provider}() {`,
    "  local stamp; stamp=$(mktemp)",
    "  (",
    `    for _ in $(seq 1 ${WATCH_TICKS}); do`,
    "      sleep 0.5",
    `      hit=$(find ${transcriptDir} -name '*.jsonl' -newer "$stamp" 2>/dev/null | head -1)`,
    '      if [ -n "$hit" ]; then',
    '        base=$(basename "$hit" .jsonl)',
    `        printf '\\033]9;78;${provider};%s\\033\\\\' "$base" > /dev/tty`,
    "        break",
    "      fi",
    "    done",
    '    rm -f "$stamp"',
    "  ) 2>/dev/null &",
    `  command ${provider} "$@"`,
    "}",
  ].join("\n");
}

/**
 * The script bash sources as its rcfile. Exposed for tests (and for reading:
 * this is the whole of what TermX does to a remote machine).
 */
export function remoteRcScript(options: SshBootstrapOptions = {}): string {
  const lines = [
    // Deliberately ASCII: the remote script should not depend on the remote
    // locale decoding it, however tolerant `base64 -d` is about the bytes.
    "# TermX session bootstrap: sourced once, then deleted.",
    // The user's own shell setup comes first; TermX only adds to it.
    "[ -f ~/.bashrc ] && . ~/.bashrc",
    // AFTER the bashrc, or a bashrc that sets PROMPT_COMMAND would win and the
    // pane would never learn its remote cwd.
    String.raw`PROMPT_COMMAND='printf "\033]9;9;%s\033\\" "$PWD"'`,
    providerWrapper("claude", '"$HOME/.claude/projects"'),
    providerWrapper("codex", '"$HOME/.codex/sessions"'),
  ];
  if (options.remoteCwd !== undefined && options.remoteCwd.length > 0) {
    // A failed cd shows up in the terminal itself (spec §5) — nothing to catch.
    lines.push(`cd ${singleQuote(options.remoteCwd)}`);
  }
  // Last: bash has finished reading the file by the time this runs, and the
  // path survives the exec only in TERMX_RC.
  lines.push('rm -f "$TERMX_RC"', "");
  return lines.join("\n");
}

/**
 * The full local command to type into a fresh shell. Throws for an alias that
 * is not a plain ssh config alias — callers pass names from the parsed config,
 * so a throw here means a bug, not user input.
 */
export function sshConnectCommand(
  alias: string,
  options: SshBootstrapOptions = {},
): string {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`unsafe ssh alias: ${JSON.stringify(alias)}`);
  }
  const payload = base64Utf8(remoteRcScript(options));
  const oneLiner = [
    "tmp=$(mktemp)",
    `echo ${payload} | base64 -d > "$tmp"`,
    // -i keeps it interactive; TERMX_RC lets the rcfile clean up after itself.
    'TERMX_RC="$tmp" exec bash --rcfile "$tmp" -i',
  ].join("; ");
  // -t forces a pty: without it there is no /dev/tty for the capture and no
  // usable interactive shell.
  return `ssh -t ${alias} '${oneLiner}'`;
}
