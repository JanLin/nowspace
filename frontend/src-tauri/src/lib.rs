use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Launch the Python backend sidecar
            let sidecar = app.shell().sidecar("nowspace-server").unwrap();
            let (mut _rx, _child) = sidecar.spawn().expect("Failed to spawn sidecar");

            // Keep child handle alive so the process doesn't get killed
            app.manage(_child);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
