mod artifacts;
mod bootstrap;
mod file_view;
mod folders;
mod llm_sessions;
mod outputs;
mod paths;
mod storage;
mod transcript;

pub use bootstrap::{bootstrap_host, bootstrap_with, BootstrapOptions, BootstrapResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Every command added here also needs its name in build.rs (to generate
        // the allow-* ACL permission) and that permission in
        // capabilities/default.json, or the renderer's invoke is denied.
        .invoke_handler(tauri::generate_handler![
            bootstrap::bootstrap_host,
            storage::read_app_file,
            storage::write_app_file,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running TermX");
}
