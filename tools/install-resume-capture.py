"""Install TermX's silent SessionStart capture hooks, preserving existing hooks.

Run after building termx-host. Every changed settings file receives a dated
byte-for-byte backup. Codex still requires its normal /hooks trust review.
"""
import argparse
import base64
import datetime
import json
import os
from pathlib import Path


def codex_command():
    # A fixed PowerShell adapter passes stdin as bytes (including Unicode) to
    # the native helper. It never interpolates transcript fields into code.
    script = """$ProgressPreference = 'SilentlyContinue'
try {
if ($env:TERMX_HOST_EXE -and $env:TERMX_AGENT_LAUNCH) {
  $termxCapture = [System.Diagnostics.Process]::new()
  $termxCapture.StartInfo.FileName = $env:TERMX_HOST_EXE
  $termxCapture.StartInfo.Arguments = '--capture-agent codex'
  $termxCapture.StartInfo.UseShellExecute = $false
  $termxCapture.StartInfo.CreateNoWindow = $true
  $termxCapture.StartInfo.RedirectStandardInput = $true
  if ($termxCapture.Start()) {
    [Console]::OpenStandardInput().CopyTo($termxCapture.StandardInput.BaseStream)
    $termxCapture.StandardInput.Close()
    if (-not $termxCapture.WaitForExit(4000)) { $termxCapture.Kill() }
  }
  $termxCapture.Dispose()
}
} catch {}
exit 0
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    return "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded


def merged_hooks(original, provider, executable):
    if not isinstance(original, dict):
        raise ValueError("Settings must contain a JSON object")
    result = json.loads(json.dumps(original))
    hooks = result.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Existing hooks must be an object")
    groups = hooks.setdefault("SessionStart", [])
    if not isinstance(groups, list):
        raise ValueError("Existing SessionStart hooks must be an array")
    # An explicit marker identifies only this installer's own group. Preserve
    # all unrelated hooks, including the earlier identity-only Python hook.
    marker = "TermX launch configuration capture (v1)"
    groups[:] = [group for group in groups if not isinstance(group, dict)
                 or not (isinstance(group.get("hooks"), list) and len(group["hooks"]) == 1
                         and isinstance(group["hooks"][0], dict) and group["hooks"][0].get("statusMessage") == marker)]
    if provider == "claude":
        handler = {"type": "command", "command": str(executable), "args": ["--capture-agent", "claude"], "timeout": 5}
    elif provider == "codex":
        command = codex_command()
        handler = {"type": "command", "command": command, "commandWindows": command, "timeout": 5}
    else:
        raise ValueError("Unknown provider")
    handler["statusMessage"] = marker
    groups.append({"matcher": "^(startup|resume|clear)$", "hooks": [handler]})
    return result


def install(path, provider, executable, dry_run=False):
    original_bytes = path.read_bytes() if path.exists() else None
    original = json.loads(original_bytes.decode("utf-8-sig")) if original_bytes else {}
    merged = merged_hooks(original, provider, executable)
    if merged == original:
        return "unchanged"
    if dry_run:
        return "would update"
    path.parent.mkdir(parents=True, exist_ok=True)
    if original_bytes is not None:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = path.with_name(path.name + ".termx-backup-" + stamp)
        with backup.open("xb") as handle:
            handle.write(original_bytes)
    temporary = path.with_name(path.name + ".termx-tmp-" + str(os.getpid()))
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(merged, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return "updated"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-exe", type=Path, required=True)
    parser.add_argument("--claude-dir", type=Path, default=Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))))
    parser.add_argument("--codex-dir", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    executable = args.host_exe.resolve(strict=True)
    for provider, path in [("claude", args.claude_dir / "settings.json"), ("codex", args.codex_dir / "hooks.json")]:
        print(provider + ": " + install(path, provider, executable, args.dry_run))


if __name__ == "__main__":
    main()
