//! The desktop shell: a window around the web app, plus what a browser can't
//! do — read and write files by path, open files from Finder / the command
//! line, upload to a board over FTP, and ask before closing with unsaved
//! changes. File dialogs come from the dialog plugin; the app itself lives in
//! packages/app.

mod remote;

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

/// Open a link in the real browser.
///
/// A plain anchor would navigate the app's own webview to the page and leave
/// the editor with no way back. Only http(s) is allowed through, and the URL is
/// passed as one argument to a program that is not a shell — so even though
/// every caller is a constant in the app today, nothing here can be talked into
/// running a command.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("refusing to open {url}: only http and https"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // rundll32 rather than `cmd /c start`, which would put the URL through a shell
        let mut c = std::process::Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("could not open {url}: {e}"))
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
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, take_pending_files, set_dirty, open_url,
            remote::remote_probe, remote::remote_list, remote::remote_upload,
        ])
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
