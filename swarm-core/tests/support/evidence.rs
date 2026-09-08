use std::path::{Path, PathBuf};
fn sources(path: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, files);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
}
/// Git blob object hashes identify the exact on-disk sources (including edits)
/// and compiled test executable. No repository mutation or git index access.
pub fn manifest() -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![
        root.join("Cargo.toml"),
        root.join("../Cargo.lock"),
        std::env::current_exe().unwrap(),
    ];
    sources(&root.join("src"), &mut files);
    sources(&root.join("tests"), &mut files);
    files.sort();
    let hashes = std::process::Command::new("git")
        .args(["hash-object", "--no-filters"])
        .args(&files)
        .current_dir(&root)
        .output()
        .expect("git source hashes");
    assert!(hashes.status.success());
    let revision = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(revision.status.success());
    let mut result = format!(
        "revision={}sqlite={}\nhash_algorithm=git-blob-SHA1\n",
        String::from_utf8(revision.stdout).unwrap(),
        rusqlite::version()
    );
    for (path, hash) in files
        .iter()
        .zip(String::from_utf8(hashes.stdout).unwrap().lines())
    {
        result.push_str(&format!("{hash} {}\n", path.display()));
    }
    result
}
