mod bootstrap;
mod folders;
mod paths;
mod storage;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running TermX");
}
