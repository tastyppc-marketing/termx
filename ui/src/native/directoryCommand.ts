/** A literal directory change for the two supported local Windows shells. */
export function directoryCommand(profile: string, path: string): string | null {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(path)
    || /[\x00-\x1f\x7f"]/.test(path)) return null;
  if (profile === "powershell") {
    return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`;
  }
  // Percent expansion is active even inside quotes; delayed expansion may
  // also be enabled in an existing cmd shell. Never change the path silently.
  // cmd cannot use a UNC current directory. Do not create an implicit drive
  // mapping with pushd: that changes the user's shell stack and drive state.
  if (profile === "cmd" && /^[A-Za-z]:[\\/]/.test(path) && !/[%!]/.test(path)) return `cd /d "${path}"`;
  return null;
}
