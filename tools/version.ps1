# tools/version.ps1 -- the only way TermX's version changes.
#
# Rewrites the four version manifests (tauri.conf.json, ui/package.json,
# ui/src-tauri/Cargo.toml, host/Cargo.toml) plus the two root entries of
# ui/package-lock.json so they all declare the same X.Y.Z. Guarded by
# ui/src/__tests__/versionSync.test.ts. Cargo.lock files are NOT touched;
# `cargo update -w` (run by release.ps1) refreshes them.
#
# Usage: powershell -NoProfile -File tools\version.ps1 -Version 0.3.0
# Exit 0 on success, 1 on bad input or a manifest without a version field.
#
# PowerShell 5.1 notes: files are read and written as UTF-8 (Get-Content
# without -Encoding would read ANSI and mangle non-ASCII comments), the
# original BOM state and line endings are preserved, a file that already
# carries the version is left untouched, and replacement counts go through a
# Regex instance because the static [regex]::Replace has no count overload.
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { Write-Error "Version must be X.Y.Z (got '$Version')"; exit 1 }
$root = Split-Path -Parent $PSScriptRoot

function Set-VersionField([string]$path, [string]$pattern, [int]$count) {
  if (-not (Test-Path -LiteralPath $path)) { Write-Error "missing manifest $path"; exit 1 }
  $bytes = [IO.File]::ReadAllBytes($path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $regex = New-Object System.Text.RegularExpressions.Regex $pattern
  if (-not $regex.IsMatch($text)) { Write-Error "no version field in $path"; exit 1 }
  $updated = $regex.Replace($text, "`${1}$Version`${2}", $count)
  if ($updated -eq $text) { return }
  [IO.File]::WriteAllText($path, $updated, (New-Object System.Text.UTF8Encoding($hasBom)))
}

$jsonPattern = '("version"\s*:\s*")[^"]+(")'
$cargoPattern = '(?m)^(version\s*=\s*")[^"]+(")'

Set-VersionField (Join-Path $root "ui\src-tauri\tauri.conf.json") $jsonPattern 1
Set-VersionField (Join-Path $root "ui\package.json") $jsonPattern 1
$lock = Join-Path $root "ui\package-lock.json"
if (Test-Path -LiteralPath $lock) {
  # Root version appears twice at the top of package-lock (root + packages[""]).
  Set-VersionField $lock $jsonPattern 2
}
Set-VersionField (Join-Path $root "ui\src-tauri\Cargo.toml") $cargoPattern 1
Set-VersionField (Join-Path $root "host\Cargo.toml") $cargoPattern 1
Write-Host "TermX version set to $Version in 4 manifests"
exit 0
