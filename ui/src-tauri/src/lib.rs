mod artifacts;
mod bootstrap;
mod chat_feed;
mod cleanup;
mod file_view;
mod folders;
mod llm_sessions;
mod outputs;
mod paths;
mod pane_agent_status;
mod plugins;
mod power;
mod reveal;
mod ssh;
mod storage;
mod transcript;
mod updates;

pub use bootstrap::{bootstrap_host, bootstrap_with, BootstrapOptions, BootstrapResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Sleep kills the UI<->daemon socket silently; the renderer's reconnect
        // machine needs to be TOLD, so it can drop the socket before the freeze
        // and reconnect on wake instead of waiting on a corpse.
        .setup(|app| {
            // The NSIS pre-install hook renames running sidecars to *.old
            // instead of killing them; sweep those leftovers on every launch.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    cleanup::remove_stale_binaries(dir);
                }
            }
            power::start(app.handle().clone());
            Ok(())
        })
        // Every command added here also needs its name in build.rs (to generate
        // the allow-* ACL permission) and that permission in
        // capabilities/default.json, or the renderer's invoke is denied.
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap_host,
            storage::read_app_file,
            storage::write_app_file,
            plugins::plugin_read_runtime,
            plugins::plugin_read_manifest,
            plugins::plugin_probe,
            plugins::plugin_spawn,
            plugins::plugin_stderr_tail,
            ssh::read_ssh_config,
            ssh::protect_secret,
            ssh::unprotect_secret,
            ssh::ssh_probe,
            folders::list_dirs,
            reveal::open_folder,
            pane_agent_status::pane_agent_status,
            pane_agent_status::mark_model_ambiguous,
            pane_agent_status::compact_conversation_captures,
            updates::check_for_updates,
            updates::open_update_release,
            updates::download_update,
            updates::install_update,
            llm_sessions::list_llm_sessions,
            llm_sessions::generate_session_note,
            llm_sessions::generate_session_bundle,
            outputs::list_session_outputs,
            outputs::dismiss_session_output,
            artifacts::list_session_artifacts,
            file_view::read_text_file,
            transcript::read_transcript_window,
            transcript::search_transcript,
            chat_feed::chat_feed_open,
            chat_feed::chat_feed_poll,
            chat_feed::chat_feed_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TermX");
}
