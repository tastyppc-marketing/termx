//! Updates are NSIS installers published in the same private GitHub repository.
//! Use gh's existing login; never copy authentication tokens into the renderer.
//!
//! A release qualifies only when it carries the installer asset for this
//! architecture AND a `termx-sha256:` line in its body. Optional body markers
//! (`termx-update: force`, `termx-host: changed`) aggregate over every
//! qualifying release newer than the running version, so skipping a forced
//! release does not un-force the update.
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const REPOSITORY: &str = "tastyppc-marketing/termx";
const MAX_RESPONSE: u64 = 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    release_tag: Option<String>,
    forced: bool,
    host_changed: bool,
    sha256: Option<String>,
    asset_name: Option<String>,
    notes_url: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    body: String,
    assets: Vec<Asset>,
}

/// Machine-readable lines in a release body, one per line, anchored at the
/// line start, case-insensitive. Only the first well-formed digest counts.
#[derive(Debug, Default, PartialEq)]
struct Markers {
    forced: bool,
    host_changed: bool,
    sha256: Option<String>,
}

fn parse_markers(body: &str) -> Markers {
    let mut m = Markers::default();
    for line in body.lines() {
        let lower = line.trim_end().to_ascii_lowercase();
        if lower == "termx-update: force" {
            m.forced = true;
        } else if lower == "termx-host: changed" {
            m.host_changed = true;
        } else if let Some(rest) = lower.strip_prefix("termx-sha256:") {
            let hex = rest.trim();
            if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && m.sha256.is_none() {
                m.sha256 = Some(hex.to_owned());
            }
        }
    }
    m
}

fn installer_asset_name(version: &Version, arch: &str) -> String {
    format!("TermX-Setup-{version}-{arch}.exe")
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    state: String,
}

fn stable_version(tag: &str) -> Option<Version> {
    if tag.len() > 100
        || !tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    {
        return None;
    }
    Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .ok()
        .filter(|v| v.pre.is_empty())
}

fn select_release(json: &[u8], current: &str, arch: &str) -> Result<UpdateResult, String> {
    let current_version = Version::parse(current).map_err(|_| "TermX build version is invalid.")?;
    let releases: Vec<Release> = serde_json::from_slice(json)
        .map_err(|_| "GitHub returned an unreadable release catalog.")?;
    // A qualifying release carries the installer for this architecture AND a
    // digest line. A lone UI binary, another architecture, or GitHub's
    // automatically generated source archive is not an update.
    let qualifying: Vec<(Version, String, Markers)> = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let version = stable_version(&r.tag_name)?;
            let expected = installer_asset_name(&version, arch);
            let has_asset = r.assets.iter().any(|a| {
                a.size > 0 && a.state == "uploaded" && a.name.eq_ignore_ascii_case(&expected)
            });
            let markers = parse_markers(&r.body);
            (has_asset && markers.sha256.is_some()).then_some((version, r.tag_name, markers))
        })
        .collect();
    let newer = |v: &Version| v.cmp_precedence(&current_version).is_gt();
    let forced = qualifying.iter().any(|(v, _, m)| newer(v) && m.forced);
    let host_changed = qualifying.iter().any(|(v, _, m)| newer(v) && m.host_changed);
    let latest = qualifying
        .into_iter()
        .max_by(|a, b| a.0.cmp_precedence(&b.0));
    Ok(match latest {
        Some((version, tag, markers)) => UpdateResult {
            status: if newer(&version) { "available" } else { "current" },
            current_version: current.into(),
            latest_version: Some(version.to_string()),
            notes_url: Some(release_url(&tag)?),
            asset_name: Some(installer_asset_name(&version, arch)),
            release_tag: Some(tag),
            forced,
            host_changed,
            sha256: markers.sha256,
        },
        None => UpdateResult {
            status: "no-release",
            current_version: current.into(),
            latest_version: None,
            release_tag: None,
            forced: false,
            host_changed: false,
            sha256: None,
            asset_name: None,
            notes_url: None,
        },
    })
}
fn release_url(tag: &str) -> Result<String, String> {
    stable_version(tag).ok_or("Invalid TermX release tag.")?;
    Ok(format!(
        "https://github.com/{REPOSITORY}/releases/tag/{tag}"
    ))
}

/// A temporary file avoids pipe-drain threads or inherited pipe handles that
/// can outlive gh. Both elapsed time and bytes written are capped; no tokens or
/// stderr ever leave the subprocess. Only this freshly spawned child is killed.
fn bounded_output(
    mut command: Command,
    timeout: Duration,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let mut output = tempfile::tempfile().map_err(|_| "Could not prepare the update check.")?;
    command.stdin(Stdio::null()).stderr(Stdio::null()).stdout(
        output
            .try_clone()
            .map_err(|_| "Could not prepare the update check.")?,
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|_| {
        "Update checks need GitHub CLI (gh) installed and signed in to this private repository."
    })?;
    let deadline = Instant::now() + timeout;
    let result = loop {
        if output.metadata().map(|m| m.len()).unwrap_or(max_bytes + 1) > max_bytes {
            break Err("GitHub's release catalog exceeded the size limit.".to_owned());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("GitHub could not be reached or access was denied. Check your connection and gh login.".to_owned())
                }
            }
            Err(_) => break Err("Could not read the update check result.".to_owned()),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            break Err("The GitHub update check timed out.".to_owned());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| "Could not read the release catalog.")?;
    let mut bytes = Vec::new();
    output
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the release catalog.")?;
    if bytes.len() as u64 > max_bytes {
        return Err("GitHub's release catalog exceeded the size limit.".into());
    }
    Ok(bytes)
}

/// `gh release download` argv. Empty when the tag or asset name is not the
/// fixed shape a release carries, so nothing user-controlled reaches gh.
fn download_args(tag: &str, asset_name: &str, dir: &Path) -> Vec<String> {
    if stable_version(tag).is_none()
        || asset_name.is_empty()
        || asset_name.len() > 100
        || !asset_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        || asset_name.starts_with('.')
    {
        return Vec::new();
    }
    [
        "release",
        "download",
        tag,
        "--repo",
        REPOSITORY,
        "--pattern",
        asset_name,
        "--dir",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([dir.to_string_lossy().into_owned(), "--clobber".to_owned()])
    .collect()
}

/// NSIS argv: `/S` is silent; `/D=<dir>` must be LAST and unquoted, even when
/// the directory contains spaces.
fn installer_args(install_dir: &Path) -> Vec<String> {
    vec!["/S".to_owned(), format!("/D={}", install_dir.display())]
}

/// Compare the file's SHA-256 with the release body's digest. A mismatch or an
/// empty file is deleted so a retry downloads again instead of trusting it.
fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|_| "Could not read the downloaded update.")?;
    if bytes.is_empty() {
        let _ = std::fs::remove_file(path);
        return Err("The downloaded update is empty.".into());
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(expected_hex) {
        let _ = std::fs::remove_file(path);
        return Err("The update failed verification and was discarded. Click to retry.".into());
    }
    Ok(())
}

/// `%LOCALAPPDATA%\TermX\updates`, the only folder installers are run from.
fn updates_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or("LOCALAPPDATA is not set.")?;
    Ok(base.join("TermX").join("updates"))
}

/// One folder per release version under the updates root.
fn updates_dir(version: &str) -> Result<PathBuf, String> {
    Ok(updates_root()?.join(version))
}

/// An installer may run only when it is an absolute, dot-free path inside the
/// updates root and ends with `.exe`.
fn installer_is_allowed(installer: &Path, updates_root: &Path) -> bool {
    let clean = installer
        .components()
        .all(|c| !matches!(c, Component::ParentDir | Component::CurDir));
    let is_exe = installer
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    installer.is_absolute() && clean && is_exe && installer.starts_with(updates_root)
}

fn check_at(current: &str) -> Result<UpdateResult, String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err("No installer is published for this architecture.".into()),
    };
    let mut command = Command::new("gh");
    command
        .args([
            "api",
            "--hostname",
            "github.com",
            &format!("repos/{REPOSITORY}/releases?per_page=100"),
        ])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env_remove("GH_DEBUG");
    let bytes = bounded_output(command, Duration::from_secs(10), MAX_RESPONSE)?;
    select_release(&bytes, current, arch)
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateResult, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || check_at(&version))
        .await
        .map_err(|_| "The update checker could not finish.".to_owned())?
}

/// Download the installer for `tag` through gh into the per-version updates
/// folder and verify its digest. Returns the installer path. A file that is
/// already present and verifies is reused without a network call.
#[tauri::command]
pub async fn download_update(
    tag: String,
    asset_name: String,
    sha256: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = stable_version(&tag).ok_or("Invalid TermX release tag.")?;
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid update digest.".into());
        }
        let dir = updates_dir(&version.to_string())?;
        let args = download_args(&tag, &asset_name, &dir);
        if args.is_empty() {
            return Err("Invalid update reference.".into());
        }
        std::fs::create_dir_all(&dir).map_err(|_| "Could not create the updates folder.")?;
        let target = dir.join(&asset_name);
        if target.is_file() && verify_sha256(&target, &sha256).is_ok() {
            return Ok(target.to_string_lossy().into_owned());
        }
        let mut command = Command::new("gh");
        command
            .args(&args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env_remove("GH_DEBUG");
        bounded_output(command, Duration::from_secs(300), MAX_RESPONSE)
            .map_err(|e| e.replace("update check", "update download"))?;
        if !target.is_file() {
            return Err("GitHub did not deliver the installer. Check your connection and gh login.".into());
        }
        verify_sha256(&target, &sha256)?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "The update download could not finish.".to_owned())?
}

/// Run a verified installer silently into this TermX's folder, then exit so
/// NSIS can replace the files. The installer's post-install hook relaunches
/// TermX when it was started silently.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, installer_path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|_| "Could not locate TermX.")?;
    let install_dir = exe
        .parent()
        .ok_or("Could not locate TermX.")?
        .to_path_buf();
    let installer = PathBuf::from(&installer_path);
    if !installer_is_allowed(&installer, &updates_root()?) {
        return Err("Refusing to run an installer from outside the updates folder.".into());
    }
    if !installer.is_file() {
        return Err("The downloaded installer is missing. Download the update again.".into());
    }
    let mut command = Command::new(&installer);
    command
        .args(installer_args(&install_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|_| "Could not start the installer.".to_owned())?;
    // NSIS waits for this process to exit before replacing files; leave now.
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn open_update_release(tag: String) -> Result<(), String> {
    let url = release_url(&tag)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Fixed HTTPS destination, passed directly as one argument, never a shell command.
        #[cfg(windows)]
        let opener = "explorer.exe";
        #[cfg(target_os = "macos")]
        let opener = "open";
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let opener = "xdg-open";
        let mut child = Command::new(opener)
            .arg(url)
            .spawn()
            .map_err(|_| "Could not open the GitHub release.".to_owned())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    })
    .await
    .map_err(|_| "Could not open the GitHub release.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn release(version: &str) -> Value {
        json!({"tag_name":format!("v{version}"),"draft":false,"prerelease":false,
            "body":format!("termx-sha256: {}
Notes.", "a".repeat(64)),
            "assets":[{"name":format!("TermX-Setup-{version}-x64.exe"),"size":1234,"state":"uploaded"}]})
    }
    fn check(values: Vec<Value>, current: &str) -> Result<UpdateResult, String> {
        select_release(&serde_json::to_vec(&values).unwrap(), current, "x64")
    }
    #[test]
    fn markers_parse_case_insensitively_at_line_start() {
        let m = parse_markers("Intro
TERMX-UPDATE: Force
  termx-host: changed
termx-sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
");
        assert!(m.forced);
        assert!(!m.host_changed, "indented line does not count");
        assert_eq!(
            m.sha256.as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert!(parse_markers("termx-sha256: short").sha256.is_none());
    }
    #[test]
    fn forced_and_host_changed_aggregate_over_every_newer_release() {
        let mut forced_mid = release("0.3.1");
        forced_mid["body"] = json!(format!(
            "termx-update: force
termx-host: changed
termx-sha256: {}",
            "b".repeat(64)
        ));
        let result = check(vec![release("0.3.0"), forced_mid, release("0.3.2")], "0.3.0").unwrap();
        assert_eq!(result.release_tag.as_deref(), Some("v0.3.2"));
        assert!(result.forced);
        assert!(result.host_changed);
        assert_eq!(result.sha256.as_deref(), Some(&*"a".repeat(64)));
        assert_eq!(result.asset_name.as_deref(), Some("TermX-Setup-0.3.2-x64.exe"));
        assert_eq!(
            result.notes_url.as_deref(),
            Some("https://github.com/tastyppc-marketing/termx/releases/tag/v0.3.2")
        );
        // A forced release at or below the running version does not force.
        let older = check(vec![release("0.3.0"), release("0.3.1")], "0.3.1").unwrap();
        assert!(!older.forced);
    }
    #[test]
    fn a_release_without_a_digest_never_qualifies() {
        let mut nodigest = release("0.4.0");
        nodigest["body"] = json!("no markers");
        assert_eq!(check(vec![nodigest], "0.2.0").unwrap().status, "no-release");
    }
    #[test]
    fn uses_semantic_precedence_and_highest_stable_release() {
        let result = check(
            vec![release("0.9.0"), release("0.10.0"), release("0.8.0")],
            "0.9.0",
        )
        .unwrap();
        assert_eq!(result.status, "available");
        assert_eq!(result.release_tag.as_deref(), Some("v0.10.0"));
        assert_eq!(
            check(vec![release("0.10.0+build2")], "0.10.0+build1")
                .unwrap()
                .status,
            "current"
        );
        assert_eq!(
            check(vec![release("0.9.0")], "0.10.0").unwrap().status,
            "current"
        );
    }
    #[test]
    fn empty_catalog_is_not_up_to_date() {
        assert_eq!(check(vec![], "0.2.0").unwrap().status, "no-release");
    }
    #[test]
    fn ignores_unfinished_unstable_or_incomplete_packages() {
        let mut draft = release("0.3.0");
        draft["draft"] = json!(true);
        let mut prerelease = release("0.4.0");
        prerelease["prerelease"] = json!(true);
        let mut lone_exe = release("0.5.0");
        lone_exe["assets"][0]["name"] = json!("TermX.exe");
        let mut wrong_arch = release("0.6.0");
        wrong_arch["assets"][0]["name"] = json!("TermX-Setup-0.6.0-arm64.exe");
        let mut pending = release("0.7.0");
        pending["assets"][0]["state"] = json!("new");
        let mut empty = release("0.8.0");
        empty["assets"][0]["size"] = json!(0);
        assert_eq!(
            check(
                vec![
                    draft,
                    prerelease,
                    lone_exe,
                    wrong_arch,
                    pending,
                    empty,
                    release("0.9.0-beta.1"),
                    release("garbage")
                ],
                "0.2.0"
            )
            .unwrap()
            .status,
            "no-release"
        );
    }
    #[test]
    fn unavailable_or_malformed_data_never_claims_current() {
        assert!(select_release(br#"{"message":"Not Found"}"#, "0.2.0", "x64").is_err());
        assert!(select_release(b"not json", "0.2.0", "x64").is_err());
        assert!(check(vec![], "garbage").is_err());
    }
    #[test]
    fn release_links_are_fixed_to_the_repository_and_valid_version_tags() {
        assert_eq!(
            release_url("v0.3.0").unwrap(),
            "https://github.com/tastyppc-marketing/termx/releases/tag/v0.3.0"
        );
        for tag in [
            "https://evil.test",
            "../../evil",
            "v0.3.0?x",
            "v0.3.0\n",
            "v0.3.0-beta.1",
        ] {
            assert!(release_url(tag).is_err(), "{tag}");
        }
    }
    #[test]
    fn download_and_installer_argv_are_fixed_shape() {
        let dir = std::path::Path::new("C:\\u\\updates\\0.3.0");
        assert_eq!(
            download_args("v0.3.0", "TermX-Setup-0.3.0-x64.exe", dir),
            vec![
                "release",
                "download",
                "v0.3.0",
                "--repo",
                "tastyppc-marketing/termx",
                "--pattern",
                "TermX-Setup-0.3.0-x64.exe",
                "--dir",
                "C:\\u\\updates\\0.3.0",
                "--clobber"
            ]
        );
        assert!(download_args("v0.3.0\n", "x", dir).is_empty(), "bad tag yields no argv");
        assert!(download_args("v0.3.0", "../x.exe", dir).is_empty(), "bad asset yields no argv");
        let args = installer_args(std::path::Path::new(
            "C:\\Users\\me\\AppData\\Local\\Programs\\TermX",
        ));
        assert_eq!(
            args,
            vec![
                "/S".to_owned(),
                "/D=C:\\Users\\me\\AppData\\Local\\Programs\\TermX".to_owned()
            ]
        );
    }
    #[test]
    fn digest_verification_rejects_mismatch_and_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.exe");
        std::fs::write(&file, b"hello").unwrap();
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_sha256(&file, good).is_ok());
        assert!(verify_sha256(&file, &good.to_ascii_uppercase()).is_ok());
        assert!(verify_sha256(&file, &"0".repeat(64))
            .unwrap_err()
            .contains("verification"));
        assert!(!file.exists());
    }
    #[test]
    fn installer_must_live_in_the_updates_folder() {
        let root = std::path::Path::new("C:\\u\\AppData\\Local\\TermX\\updates");
        assert!(installer_is_allowed(
            std::path::Path::new("C:\\u\\AppData\\Local\\TermX\\updates\\0.3.0\\TermX-Setup-0.3.0-x64.exe"),
            root
        ));
        for bad in [
            "C:\\u\\AppData\\Local\\TermX\\updates\\0.3.0\\notes.txt",
            "C:\\u\\AppData\\Local\\TermX\\updates\\..\\evil.exe",
            "C:\\u\\AppData\\Local\\TermX\\updates-evil\\x.exe",
            "D:\\evil.exe",
            "evil.exe",
        ] {
            assert!(!installer_is_allowed(std::path::Path::new(bad), root), "{bad}");
        }
    }
    #[test]
    #[cfg(windows)]
    fn subprocess_deadline_and_output_limit_are_enforced() {
        let mut slow = Command::new("powershell.exe");
        slow.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 20",
        ]);
        let started = Instant::now();
        assert!(bounded_output(slow, Duration::from_millis(100), 1024)
            .unwrap_err()
            .contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        let mut huge = Command::new("powershell.exe");
        huge.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write(('x' * 10000))",
        ]);
        assert!(bounded_output(huge, Duration::from_secs(5), 100)
            .unwrap_err()
            .contains("size limit"));
    }
    #[test]
    #[ignore = "explicit integration check using this machine's existing gh login"]
    fn private_repository_check() {
        println!("{:?}", check_at("0.2.0").unwrap());
    }
}
