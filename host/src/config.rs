//! config.json — human-editable, created with defaults on first run.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

fn default_scrollback_bytes() -> usize {
    4 * 1024 * 1024
}
fn default_profile() -> String {
    "powershell".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_scrollback_bytes")]
    pub scrollback_bytes: usize,
    #[serde(default = "default_profile")]
    pub default_profile: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            scrollback_bytes: default_scrollback_bytes(),
            default_profile: default_profile(),
        }
    }
}

/// Load <data>/config.json, creating it with defaults if absent.
/// A malformed file is a hard error — we never silently overwrite user edits.
pub fn load_or_create(data_dir: &Path) -> Result<Config> {
    let path = data_dir.join("config.json");
    if path.is_file() {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let cfg: Config = serde_json::from_str(&text)
            .with_context(|| format!("parsing {} — fix or delete it", path.display()))?;
        Ok(cfg)
    } else {
        let cfg = Config::default();
        std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_defaults_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = load_or_create(tmp.path()).unwrap();
        assert_eq!(cfg.scrollback_bytes, 4 * 1024 * 1024);
        assert_eq!(cfg.default_profile, "powershell");
        assert!(tmp.path().join("config.json").is_file(), "writes the file");
    }

    #[test]
    fn reads_existing_and_fills_missing_keys() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("config.json"),
            r#"{ "scrollback_bytes": 1024 }"#,
        )
        .unwrap();
        let cfg = load_or_create(tmp.path()).unwrap();
        assert_eq!(cfg.scrollback_bytes, 1024);
        assert_eq!(cfg.default_profile, "powershell", "missing key -> default");
    }

    #[test]
    fn malformed_json_is_an_error_not_a_silent_reset() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json"), "{ not json").unwrap();
        assert!(
            load_or_create(tmp.path()).is_err(),
            "never clobber a user's broken edit"
        );
    }
}
