//! Directory completion for the folder-search palette.
//!
//! This is a completion source, not a filesystem API: it is driven by
//! keystrokes over half-typed paths, so every failure mode (junk input,
//! unreadable parent, non-UTF-8 names) degrades to fewer rows rather than an
//! error. The command therefore returns a bare `Vec<String>` and can never
//! reject.

use std::path::{Path, PathBuf};

/// Upper bound on rows handed to the palette.
const MAX_RESULTS: usize = 100;

/// Tauri command: directory completions for `prefix`. Never errors.
#[tauri::command]
pub async fn list_dirs(prefix: String) -> Vec<String> {
    // `read_dir` over a user-typed path can block for seconds on a network
    // share, a spun-down drive or a directory with 100k entries, so it must
    // never run on the IPC thread — a palette that freezes the window while
    // you type is worse than no palette.
    tauri::async_runtime::spawn_blocking(move || list_dirs_for(&prefix))
        .await
        .unwrap_or_default()
}

/// Command body against the real environment.
pub fn list_dirs_for(prefix: &str) -> Vec<String> {
    list_dirs_with(prefix, user_profile_dir().as_deref())
}

fn user_profile_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Pure over the injected home dir so tests need no environment fixture.
pub(crate) fn list_dirs_with(prefix: &str, home: Option<&Path>) -> Vec<String> {
    // Surrounding whitespace comes from pasted paths far more often than a
    // real directory name starts or ends with a space.
    let expanded = expand_home(prefix.trim(), home);

    // Too little to act on, or not rooted anywhere: offer the drive roots so
    // the palette always has a starting point instead of an empty list.
    if expanded.chars().count() < 2 || !Path::new(&expanded).is_absolute() {
        return drive_roots();
    }

    let Some(idx) = expanded.rfind(['\\', '/']) else {
        return drive_roots();
    };
    let parent = parent_dir(&expanded[..idx], expanded.as_bytes()[idx] as char);
    let filter = expanded[idx + 1..].to_lowercase();

    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Vec::new();
    };

    // (is_prefix_match, lowercased name, absolute path)
    let mut matches: Vec<(bool, String, String)> = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue; // a non-UTF-8 name cannot round-trip to the renderer
        };
        if name.starts_with('.') || !is_directory(&entry) {
            continue;
        }
        let lower = name.to_lowercase();
        if !filter.is_empty() && !lower.contains(&filter) {
            continue;
        }
        matches.push((
            lower.starts_with(&filter),
            lower,
            parent.join(&name).to_string_lossy().into_owned(),
        ));
    }

    // Prefix matches first, then case-insensitive alphabetical. Sorting before
    // the cap keeps the best 100 rather than the first 100 the OS happened to
    // return.
    matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    matches.truncate(MAX_RESULTS);
    matches.into_iter().map(|(_, _, path)| path).collect()
}

/// `~`, `~\tail` and `~/tail` resolve against the user profile dir. A bare
/// `~name` is not a home reference on Windows and is left alone (it then fails
/// the absolute-path test and falls through to the drive roots).
fn expand_home(input: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return input.to_string();
    };
    let Some(rest) = input.strip_prefix('~') else {
        return input.to_string();
    };
    if rest.is_empty() {
        return home.to_string_lossy().into_owned();
    }
    let Some(tail) = rest.strip_prefix('\\').or_else(|| rest.strip_prefix('/')) else {
        return input.to_string();
    };
    // Joining "" yields the home dir plus a trailing separator, which is what
    // a bare `~\` should mean: list everything in the profile.
    home.join(tail).to_string_lossy().into_owned()
}

/// Rebuild a readable parent from the left half of the split. `C:\Dev` splits
/// to `C:`, which Windows resolves as *the current directory on drive C* rather
/// than its root, so the separator has to go back on. An empty left half (a
/// rooted path like `\Users`) means the separator itself is the parent.
fn parent_dir(left: &str, sep: char) -> PathBuf {
    if left.is_empty() {
        return PathBuf::from(sep.to_string());
    }
    if left.len() == 2 && left.ends_with(':') {
        return PathBuf::from(format!("{left}{sep}"));
    }
    PathBuf::from(left)
}

/// Directories only — but a Windows junction (`Users\All Users`) reports as a
/// symlink while being a perfectly navigable folder, so resolve those. The
/// cheap `read_dir` file type answers the common case without extra syscalls.
fn is_directory(entry: &std::fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(t) if t.is_dir() => true,
        Ok(t) if t.is_symlink() => entry.path().is_dir(),
        Ok(_) => false,
        Err(_) => entry.path().is_dir(),
    }
}

/// Existing drive roots, `A:\`..`Z:\`. Absent letters probe cheaply; an empty
/// removable drive reports false, which is what a folder picker wants anyway.
fn drive_roots() -> Vec<String> {
    (b'A'..=b'Z')
        .map(|letter| format!("{}:\\", letter as char))
        .filter(|root| Path::new(root).is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tempfile's default prefix is dot-prefixed, which the dot-skip rule would
    /// hide when a test lists the temp dir from its own parent.
    fn tempdir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("termx-folders-")
            .tempdir()
            .unwrap()
    }

    fn mkdirs(base: &Path, names: &[&str]) {
        for name in names {
            std::fs::create_dir_all(base.join(name)).unwrap();
        }
    }

    fn names_of(paths: &[String]) -> Vec<String> {
        paths
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.clone())
            })
            .collect()
    }

    /// `<dir>\<partial>` — what the palette sends while the user is typing.
    fn query(dir: &Path, partial: &str) -> Vec<String> {
        list_dirs_with(&format!("{}\\{partial}", dir.display()), None)
    }

    #[test]
    fn short_empty_and_relative_input_lists_drive_roots() {
        for junk in ["", " ", "C", "x", "Dev", "..", "./rel", "not a path at all"] {
            let got = list_dirs_with(junk, None);
            assert_eq!(
                got,
                drive_roots(),
                "{junk:?} should fall back to drive roots"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn drive_roots_are_existing_roots_only() {
        let roots = drive_roots();
        assert!(!roots.is_empty(), "Windows always has at least one drive");
        for root in &roots {
            assert!(Path::new(root).is_dir(), "{root} must exist");
            let bytes = root.as_bytes();
            assert_eq!(bytes.len(), 3, "expected `X:\\` shape, got {root}");
            assert!(bytes[0].is_ascii_uppercase());
            assert_eq!(&root[1..], ":\\");
        }
    }

    #[test]
    fn substring_match_is_case_insensitive_with_prefix_matches_first() {
        let tmp = tempdir();
        mkdirs(tmp.path(), &["alpha-src", "src-lib", "Src-app", "zsrc", "docs"]);
        let got = query(tmp.path(), "SRC");
        assert_eq!(
            names_of(&got),
            vec!["Src-app", "src-lib", "alpha-src", "zsrc"],
            "prefix matches first, then alphabetical within each group"
        );
    }

    #[test]
    fn empty_final_segment_lists_every_directory_alphabetically() {
        let tmp = tempdir();
        mkdirs(tmp.path(), &["beta", "Alpha", "gamma"]);
        let got = query(tmp.path(), "");
        assert_eq!(names_of(&got), vec!["Alpha", "beta", "gamma"]);
    }

    #[test]
    fn files_and_dot_directories_are_skipped() {
        let tmp = tempdir();
        mkdirs(tmp.path(), &["keep", ".hidden", ".git"]);
        std::fs::write(tmp.path().join("keep.txt"), b"not a dir").unwrap();
        std::fs::write(tmp.path().join("notes"), b"file named like a dir").unwrap();
        assert_eq!(names_of(&query(tmp.path(), "")), vec!["keep"]);
        assert!(query(tmp.path(), ".").is_empty(), "dot query matches nothing");
    }

    #[test]
    fn results_are_absolute_paths_under_the_queried_parent() {
        let tmp = tempdir();
        mkdirs(tmp.path(), &["projects"]);
        let got = query(tmp.path(), "proj");
        assert_eq!(got, vec![tmp.path().join("projects").to_string_lossy().into_owned()]);
        assert!(Path::new(&got[0]).is_absolute());
        assert!(Path::new(&got[0]).is_dir());
    }

    #[test]
    fn results_are_capped_at_one_hundred() {
        let tmp = tempdir();
        let names: Vec<String> = (0..120).map(|i| format!("dir-{i:03}")).collect();
        mkdirs(
            tmp.path(),
            &names.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        let got = query(tmp.path(), "dir-");
        assert_eq!(got.len(), MAX_RESULTS);
        // Sorted before the cap, so the cap keeps the alphabetical head.
        assert_eq!(names_of(&got)[0], "dir-000");
        assert_eq!(names_of(&got)[MAX_RESULTS - 1], "dir-099");
    }

    #[test]
    fn unreadable_parent_yields_no_rows() {
        let tmp = tempdir();
        let missing = tmp.path().join("no-such-dir").join("deeper");
        let got = list_dirs_with(&format!("{}\\anything", missing.display()), None);
        assert!(got.is_empty(), "missing parent must not error or guess: {got:?}");
    }

    #[test]
    fn forward_slashes_are_accepted_as_separators() {
        let tmp = tempdir();
        mkdirs(tmp.path(), &["projects"]);
        let typed = format!("{}/proj", tmp.path().display()).replace('\\', "/");
        let got = list_dirs_with(&typed, None);
        assert_eq!(names_of(&got), vec!["projects"]);
    }

    #[test]
    fn tilde_expands_against_the_injected_home() {
        let tmp = tempdir();
        mkdirs(tmp.path(), &["projects", "pictures"]);
        assert_eq!(
            names_of(&list_dirs_with("~/proj", Some(tmp.path()))),
            vec!["projects"]
        );
        assert_eq!(
            names_of(&list_dirs_with(r"~\proj", Some(tmp.path()))),
            vec!["projects"]
        );
        // A bare `~\` means "everything in the profile".
        assert_eq!(
            names_of(&list_dirs_with(r"~\", Some(tmp.path()))),
            vec!["pictures", "projects"]
        );
    }

    #[test]
    fn expand_home_only_treats_a_real_home_reference_as_one() {
        let home = Path::new(r"X:\home\me");
        assert_eq!(expand_home("~", Some(home)), r"X:\home\me");
        assert_eq!(expand_home(r"~\Dev", Some(home)), r"X:\home\me\Dev");
        assert_eq!(expand_home("~/Dev", Some(home)), r"X:\home\me\Dev");
        // Not home references: another user, or no home available at all.
        assert_eq!(expand_home("~other", Some(home)), "~other");
        assert_eq!(expand_home(r"C:\Dev", Some(home)), r"C:\Dev");
        assert_eq!(expand_home(r"~\Dev", None), r"~\Dev");
    }

    #[test]
    fn parent_dir_restores_the_root_of_a_bare_drive_letter() {
        assert_eq!(parent_dir("C:", '\\'), PathBuf::from(r"C:\"));
        assert_eq!(parent_dir("C:", '/'), PathBuf::from("C:/"));
        assert_eq!(parent_dir("", '\\'), PathBuf::from(r"\"));
        assert_eq!(parent_dir(r"C:\Dev", '\\'), PathBuf::from(r"C:\Dev"));
    }
}
