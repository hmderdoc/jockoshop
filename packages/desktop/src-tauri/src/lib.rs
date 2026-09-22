//! The desktop shell: a window around the web app, plus what a browser can't
//! do — read and write files by path, open files from Finder / the command
//! line, and ask before closing with unsaved changes. File dialogs come from
//! the dialog plugin; the app itself lives in packages/app.

use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Files the OS asked us to open before the webview was ready to hear about it.
#[derive(Default)]
struct Pending(Mutex<Vec<String>>);

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    eprintln!("jockoshop: read {path}");
    std::fs::read(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    // write beside, then rename: a crash mid-write never leaves a half file
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, &data).map_err(|e| format!("{tmp}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{path}: {e}"))
}

/// The webview calls this once it is listening, and gets whatever arrived earlier.
#[tauri::command]
fn take_pending_files(state: tauri::State<'_, Pending>) -> Vec<String> {
    eprintln!("jockoshop: webview connected");
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Told by the webview whether the document has unsaved changes.
#[tauri::command]
fn set_dirty(state: tauri::State<'_, Dirty>, dirty: bool) {
    *state.0.lock().unwrap() = dirty;
}

#[derive(Default)]
struct Dirty(Mutex<bool>);

/// Queue files to open and nudge the webview. It drains the queue with
/// `take_pending_files`, on the nudge or when it starts — whichever comes first.
fn open_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<Pending>().0.lock().unwrap().extend(paths);
    let _ = app.emit("open-files", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Pending::default())
        .manage(Dirty::default())
        .invoke_handler(tauri::generate_handler![read_file, write_file, take_pending_files, set_dirty])
        .setup(|app| {
            // files given on the command line (Windows / Linux; macOS uses the Opened event)
            let args: Vec<String> = std::env::args().skip(1).filter(|a| std::path::Path::new(a).is_file()).collect();
            open_paths(app.handle(), args);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if *window.state::<Dirty>().0.lock().unwrap() {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());   // the app asks, then calls window.destroy()
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
                open_paths(app, paths);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
