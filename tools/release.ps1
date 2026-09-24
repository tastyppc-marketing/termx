# tools/release.ps1 -- cut a TermX release: version, notes, commit, tag, push. CI builds and publishes.
#
# Usage (from anywhere; paths derive from this script's location):
#   powershell -NoProfile -File tools\release.ps1 -Version 0.3.0 [-Force] [-Notes path\to\notes.md]
#
# Produces commit `chore(release): vX.Y.Z` and annotated tag `vX.Y.Z` on main,
# pushes both, and leaves RELEASE-NOTES.md at the repo root (committed) whose
# first lines are the updater's machine markers:
#   termx-update: force     (only with -Force: every older install must update)
#   termx-host: changed     (host/ differs from the previous v* tag, or no previous tag)
# CI (.github/workflows/release.yml) appends `termx-sha256: <hex>` after building.
#
# PowerShell 5.1 note: native commands that write to stderr (git describe with
# no tags, cargo progress) throw under $ErrorActionPreference = "Stop" when
# their stderr is redirected, so those calls run inside helpers that lower the
# preference locally and check $LASTEXITCODE themselves.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$Force,
  [string]$Notes
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if ($Notes) { $Notes = (Resolve-Path -LiteralPath $Notes).Path }
Set-Location $root
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be X.Y.Z" }
$tag = "v$Version"

function Invoke-Quiet {
  # Run a native command with stderr discarded; returns stdout lines, sets $LASTEXITCODE.
  param([string]$Command, [string[]]$Arguments)
  $ErrorActionPreference = "Continue"
  $output = & $Command @Arguments 2>$null
  return $output
}

function Update-CargoLock([string]$dir) {
  Push-Location $dir
  try {
    $ErrorActionPreference = "Continue"
    & cargo update -w --offline 2>$null
    if ($LASTEXITCODE -ne 0) {
      & cargo update -w
      if ($LASTEXITCODE -ne 0) { throw "cargo update -w failed in $dir" }
    }
  } finally { Pop-Location }
}

# --- Guards -------------------------------------------------------------------
if ((git status --porcelain | Measure-Object).Count -ne 0) { throw "Working tree is dirty. Commit or stash first." }
if ((git branch --show-current) -ne "main") { throw "Release from main only." }
if (git tag -l $tag) { throw "Tag $tag already exists." }
git fetch origin --tags
if ($LASTEXITCODE -ne 0) { throw "git fetch origin --tags failed" }
if (Invoke-Quiet git @("ls-remote", "--tags", "origin", $tag)) { throw "Tag $tag already exists on origin." }

# --- Did the host daemon change since the previous release? -------------------
$previous = Invoke-Quiet git @("describe", "--tags", "--abbrev=0", "--match", "v*")
if ($LASTEXITCODE -ne 0) { $previous = $null }
$hostChanged = $true
if ($previous) {
  Invoke-Quiet git @("diff", "--quiet", "$previous", "--", "host/") | Out-Null
  $hostChanged = ($LASTEXITCODE -ne 0)
}

# --- Version bump + lock files + guard test -----------------------------------
$global:LASTEXITCODE = 0
& (Join-Path $PSScriptRoot "version.ps1") -Version $Version
if ($LASTEXITCODE -ne 0) { throw "version.ps1 failed" }
Update-CargoLock $root
Update-CargoLock (Join-Path $root "ui\src-tauri")
Push-Location (Join-Path $root "ui")
try {
  npx vitest run src/__tests__/versionSync.test.ts
  if ($LASTEXITCODE -ne 0) { throw "version sync test failed" }
} finally { Pop-Location }

# --- Release notes: machine markers first, then the human body -----------------
$bodyPath = if ($Notes) { $Notes } else { Join-Path $PSScriptRoot "RELEASE-NOTES.template.md" }
$body = [IO.File]::ReadAllText($bodyPath, [Text.Encoding]::UTF8)
$header = @()
if ($Force) { $header += "termx-update: force" }
if ($hostChanged) { $header += "termx-host: changed" }
$notesPath = Join-Path $root "RELEASE-NOTES.md"
$content = (($header -join "`n") + "`n`n" + $body.Trim() + "`n")
[IO.File]::WriteAllText($notesPath, $content, (New-Object System.Text.UTF8Encoding($false)))
if (-not $Notes) {
  Write-Host "Edit $notesPath now (keep the termx-* lines at the top), then press Enter."
  [void](Read-Host)
}

# --- Say out loud what kind of release this is, so nobody has to guess --------
$kind = if ($Force) {
  "REQUIRED update (-Force): every older install must update before it can continue"
} else {
  "optional update: older installs see a banner with Install and Later"
}
Write-Host ""
Write-Host "==> $tag is an $kind"
if ($hostChanged) { Write-Host "==> host daemon changed: the update restarts the daemon after installing" }
Write-Host "==> marker lines at the top of RELEASE-NOTES.md: $(if ($header) { $header -join ' | ' } else { '(none)' })"
Write-Host ""

# --- Commit, tag, push ---------------------------------------------------------
git add -A
if ($LASTEXITCODE -ne 0) { throw "git add failed" }
git commit -m "chore(release): $tag"
if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
git tag -a $tag -m "TermX $Version"
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }
git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push origin main failed" }
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw "git push origin $tag failed" }
Write-Host "Pushed $tag ($kind)."
Write-Host "Watch: https://github.com/tastyppc-marketing/termx/actions"
