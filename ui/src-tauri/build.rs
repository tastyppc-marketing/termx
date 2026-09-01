fn main() {
    // Register app commands so Tauri generates allow/deny ACL permissions
    // (allow-bootstrap-host, …) for capabilities/default.json.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "bootstrap_host",
                "read_app_file",
                "write_app_file",
                "read_ssh_config",
                "protect_secret",
                "unprotect_secret",
                "ssh_probe",
                "list_dirs",
                "open_folder",
                "list_llm_sessions",
                "generate_session_note",
                "generate_session_bundle",
                "list_session_outputs",
                "dismiss_session_output",
                "list_session_artifacts",
                "read_text_file",
                "read_transcript_window",
                "search_transcript",
                "chat_feed_open",
                "chat_feed_poll",
                "chat_feed_close",
                // Plugin system (Phase 1, spec §3a): ensure-up lifecycle.
                "plugin_read_runtime",
                "plugin_read_manifest",
                "plugin_probe",
                "plugin_spawn",
                "plugin_stderr_tail",
            ]),
        ),
    )
    .expect("tauri-build failed");
}
