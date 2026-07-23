mod bootstrap;
mod paths;

pub use bootstrap::{bootstrap_host, bootstrap_with, BootstrapOptions, BootstrapResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bootstrap::bootstrap_host])
        .run(tauri::generate_context!())
        .expect("error while running TermX");
}
