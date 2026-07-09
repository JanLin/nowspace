use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Launch the Python backend sidecar
            let sidecar = app.shell().sidecar("nowspace-server").unwrap();
            let (mut _rx, child) = sidecar.spawn().expect("Failed to spawn sidecar");

            // Keep the child handle so it can be killed on exit
            app.manage(Mutex::new(Some(child)));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // Stop the sidecar — otherwise it outlives the app and
                // squats port 8000 (PyInstaller runs a bootloader whose
                // python child ignores SIGKILL sent only to the parent,
                // so ask nicely with SIGTERM first).
                if let Some(state) = app_handle.try_state::<Mutex<Option<CommandChild>>>() {
                    if let Some(child) = state.lock().unwrap().take() {
                        #[cfg(unix)]
                        {
                            let _ = std::process::Command::new("kill")
                                .arg(child.pid().to_string())
                                .status();
                            std::thread::sleep(std::time::Duration::from_millis(300));
                        }
                        let _ = child.kill();
                    }
                }
            }
        });
}
