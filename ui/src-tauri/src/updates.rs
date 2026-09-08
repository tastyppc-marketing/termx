//! Updates are published portable bundles in the same private GitHub repository.
//! Use gh's existing login; never copy authentication tokens into the renderer.
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Seek, SeekFrom},
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
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
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
    let latest = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let version = stable_version(&r.tag_name)?;
            // This bundle contains BOTH portable executables. A lone UI binary or
            // GitHub's automatically generated source archive is not an update.
            let expected = format!("TermX-{version}-windows-{arch}-portable.zip");
            r.assets
                .iter()
                .any(|a| {
                    a.size > 0 && a.state == "uploaded" && a.name.eq_ignore_ascii_case(&expected)
                })
                .then_some((version, r.tag_name))
        })
        .max_by(|a, b| a.0.cmp_precedence(&b.0));
    Ok(match latest {
        Some((version, tag)) => UpdateResult {
            status: if version.cmp_precedence(&current_version).is_gt() {
                "available"
            } else {
                "current"
            },
            current_version: current.into(),
            latest_version: Some(version.to_string()),
            release_tag: Some(tag),
        },
        None => UpdateResult {
            status: "no-release",
            current_version: current.into(),
            latest_version: None,
            release_tag: None,
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

fn check_at(current: &str) -> Result<UpdateResult, String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err("No portable update format is configured for this architecture.".into()),
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
            "assets":[{"name":format!("TermX-{version}-windows-x64-portable.zip"),"size":1234,"state":"uploaded"}]})
    }
    fn check(values: Vec<Value>, current: &str) -> Result<UpdateResult, String> {
        select_release(&serde_json::to_vec(&values).unwrap(), current, "x64")
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
        lone_exe["assets"][0]["name"] = json!("termx-ui.exe");
        let mut wrong_arch = release("0.6.0");
        wrong_arch["assets"][0]["name"] = json!("TermX-0.6.0-windows-arm64-portable.zip");
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
