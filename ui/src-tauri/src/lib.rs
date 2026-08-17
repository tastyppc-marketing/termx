mod artifacts;
mod bootstrap;
mod chat_feed;
mod file_view;
mod folders;
mod llm_sessions;
mod outputs;
mod paths;
mod power;
mod ssh;
mod storage;
mod transcript;

pub use bootstrap::{bootstrap_host, bootstrap_with, BootstrapOptions, BootstrapResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Sleep kills the UI<->daemon socket silently; the renderer's reconnect
        // machine needs to be TOLD, so it can drop the socket before the freeze
        // and reconnect on wake instead of waiting on a corpse.
        .setup(|app| {
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
            ssh::read_ssh_config,
            ssh::protect_secret,
            ssh::unprotect_secret,
            ssh::ssh_probe,
            folders::list_dirs,
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
