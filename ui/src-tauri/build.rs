fn main() {
    // Register app commands so Tauri generates allow/deny ACL permissions
    // (allow-bootstrap-host, …) for capabilities/default.json.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "bootstrap_host",
                "read_app_file",
                "write_app_file",
                "list_dirs",
            ]),
        ),
    )
    .expect("tauri-build failed");
}
