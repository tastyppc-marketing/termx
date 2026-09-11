/** Original, tokenized CLI invocation. Never interpreted as shell source. */
export interface LaunchConfiguration {
  v: 1;
  provider: "claude" | "codex";
  args: string[];
  /** Preserve relative option paths, especially `codex --cd subdir`. */
  cwd: string;
}

export const LAUNCHES_FILE = "conversation_launches_v1.jsonl" as const;
const MAX_ARGUMENT_BYTES = 24_000;

export function parseLaunchConfiguration(value: unknown, provider: string): LaunchConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || raw.provider !== provider || (provider !== "claude" && provider !== "codex")
    || typeof raw.cwd !== "string" || !raw.cwd || raw.cwd.includes("\0")
    || !Array.isArray(raw.args) || raw.args.length > 512
    || !raw.args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) return null;
  if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_ARGUMENT_BYTES) return null;
  return { v: 1, provider, args: [...raw.args], cwd: raw.cwd };
}

const words = (value: string) => new Set(value.split(" "));
// Known arities identify positional prompts. They are not an allowlist:
// self-contained future options pass through unchanged. Unknown separated
// values need an explicit prompt boundary so no configuration is guessed away.
const CODEX_VALUES = words("-c --config -m --model -p --profile -s --sandbox -a --ask-for-approval --enable --disable --local-provider --add-dir -C --cd --remote --remote-auth-token-env");
const CODEX_SWITCHES = words("--oss --full-auto --approve-for-me --strict-config --yolo --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --search --no-alt-screen");
const CLAUDE_VALUES = words("--model --fallback-model --effort --permission-mode --agent --agents --settings --setting-sources --system-prompt --system-prompt-file --append-system-prompt --append-system-prompt-file --system-prompt-snapshot --max-budget-usd --max-turns --session-name --name -n --teammate-mode --autocompact --debug-file --plugin-dir --plugin-url --remote-control-session-name-prefix --json-schema");
const CLAUDE_LISTS = words("--add-dir --allowedTools --allowed-tools --disallowedTools --disallowed-tools --tools --mcp-config --betas");
const CLAUDE_SWITCHES = words("--dangerously-skip-permissions --allow-dangerously-skip-permissions --strict-mcp-config --chrome --no-chrome --ide --disable-slash-commands --verbose --ax-screen-reader --bare --brief --restricted --safe-mode --exclude-dynamic-system-prompt-sections");
const CLAUDE_OPTIONAL_VALUES = words("--debug -d --prompt-suggestions --remote-control");
const NON_INTERACTIVE_COMMANDS = words("exec e review login logout mcp mcp-server app-server app completion debug apply fork cloud features update upgrade install doctor auth setup-token agents attach auto-mode gateway import logs plugin plugins project respawn rm stop kill ultrareview remote-control sandbox queue archive delete migrate-rollouts unarchive exec-server help");
const DISPLAY_ONLY_OPTIONS = words("--help -h --version -V -v");

/** Replace selection operands and omit the initial user prompt, preserving
 * repeated/ordered configuration flags and their exact string values. */
export function resumeArguments(launch: LaunchConfiguration, id: string): string[] | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) return null;
  const codex = launch.provider === "codex";
  const values = codex ? CODEX_VALUES : CLAUDE_VALUES;
  const switches = codex ? CODEX_SWITCHES : CLAUDE_SWITCHES;
  const result = codex ? [] : ["--resume", id];
  // A trailing `-- PROMPT` leaves no positional prompt to infer among the
  // preceding option values. A terminal `--` alone does not establish this.
  const explicitPromptTail = launch.args.length >= 2 && launch.args.at(-2) === "--";
  let selection = false;
  let selectionOperand = false;
  let promptSeen = false;
  for (let i = 0; i < launch.args.length; i++) {
    const arg = launch.args[i]!;
    if (arg === "--") break; // remaining operands belong to the initial prompt
    const equal = arg.indexOf("=");
    const name = equal > 0 ? arg.slice(0, equal) : arg;
    const inline = equal > 0;
    if (DISPLAY_ONLY_OPTIONS.has(name) || (!codex && (name === "--print" || name === "-p"))) return null;
    if (codex && arg === "resume" && !selection && !promptSeen) {
      selection = true;
      selectionOperand = true;
      result.push("resume", id);
      continue;
    }
    if (codex && (name === "--last" || name === "--all" || name === "--include-non-interactive")) continue;
    if (!codex && (name === "--resume" || name === "-r" || name === "--from-pr")) {
      if (!inline && launch.args[i + 1] !== undefined && !launch.args[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (!codex && (name === "--continue" || name === "-c" || name === "--fork-session")) continue;
    if (!codex && arg.startsWith("-r") && !arg.startsWith("--") && arg.length > 2) continue;
    if (!codex && name === "--session-id") {
      if (!inline && ++i >= launch.args.length) return null;
      continue;
    }
    if (codex && (name === "--image" || name === "-i")) {
      if (!inline) {
        const start = i;
        while (launch.args[i + 1] !== undefined && !launch.args[i + 1]!.startsWith("-")) i++;
        if (i === start) return null;
      }
      continue;
    }
    if (codex && arg.startsWith("-i") && !arg.startsWith("--") && arg.length > 2) continue;
    const shortName = arg.slice(0, 2);
    const attachedValue = /^-[A-Za-z].+/.test(arg) && values.has(shortName);
    if (attachedValue) {
      result.push(arg);
    } else if (values.has(name)) {
      result.push(arg);
      if (!inline) {
        if (++i >= launch.args.length) return null;
        result.push(launch.args[i]!);
      }
    } else if (!codex && CLAUDE_LISTS.has(name)) {
      result.push(arg);
      if (!inline) {
        const start = i;
        while (launch.args[i + 1] !== undefined && !launch.args[i + 1]!.startsWith("-")) result.push(launch.args[++i]!);
        if (i === start) return null;
      }
    } else if (!codex && CLAUDE_OPTIONAL_VALUES.has(name)) {
      result.push(arg);
      if (!inline && launch.args[i + 1] !== undefined && !launch.args[i + 1]!.startsWith("-")) result.push(launch.args[++i]!);
    } else if (switches.has(name) && !inline) {
      result.push(arg);
    } else if (arg.startsWith("-")) {
      if (!/^--?[A-Za-z][A-Za-z0-9_-]*(?:=.*)?$/s.test(arg)) return null;
      result.push(arg);
      if (!inline && launch.args[i + 1] !== undefined && !launch.args[i + 1]!.startsWith("-")) {
        // `--future value` could also be a boolean followed by the one-off
        // prompt. Never silently discard the value or replay that prompt.
        // With an explicit prompt tail, retain the opaque value group exactly.
        if (!explicitPromptTail || selectionOperand) return null;
        while (launch.args[i + 1] !== undefined && !launch.args[i + 1]!.startsWith("-")) {
          const value = launch.args[++i]!;
          if (codex && !selection && (value === "resume" || NON_INTERACTIVE_COMMANDS.has(value))) return null;
          result.push(value);
        }
      }
    } else {
      if (selectionOperand) { selectionOperand = false; continue; }
      // Non-interactive subcommands must not be converted into interactive
      // resumes. At most one positional argument is the initial prompt.
      if (promptSeen || (!selection && NON_INTERACTIVE_COMMANDS.has(arg))) return null;
      promptSeen = true;
    }
  }
  if (codex && !selection) result.push("resume", id);
  return result;
}

/** Append-only durable log: first capture is the original launch baseline.
 * Pane compaction and later bare resumes cannot erase it. */
export function parseConversationLaunches(text: string | null): Map<string, LaunchConfiguration | null> {
  const found = new Map<string, LaunchConfiguration | null>();
  for (const line of text?.split("\n") ?? []) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (!row || row.v !== 1 || typeof row.provider !== "string" || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(row.id)) continue;
      const launch = parseLaunchConfiguration(row.launch, row.provider);
      const key = `${row.provider}:${row.id}`;
      if ((row.provider === "claude" || row.provider === "codex") && !found.has(key)) found.set(key, launch);
    } catch { /* tolerate torn lines */ }
  }
  return found;
}

export function encodeLaunch(launch: LaunchConfiguration): string {
  const bytes = new TextEncoder().encode(JSON.stringify(launch));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
