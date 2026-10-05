//! The desktop shell: a window per document around the web app, plus what a
//! browser can't do — read and write files by path, open files from Finder /
//! the command line, the system clipboard in other editors' formats, upload
//! to a board over FTP, and ask before closing with unsaved changes. File
//! dialogs come from the dialog plugin, updates from the updater plugin (signed;
//! the feed is latest.json on the update-feed branch, written by the release
//! workflow); the app itself lives in packages/app.

mod clip;
mod remote;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WebviewWindowBuilder, WindowEvent};

/// What the shell knows about each window, by label.
#[derive(Default)]
struct Windows(Mutex<WindowsState>);

#[derive(Default)]
struct WindowsState {
    /// files a window is to open, waiting until its webview asks for them
    pending: HashMap<String, Vec<String>>,
    /// windows with unsaved changes
    dirty: HashSet<String>,
    /// windows still showing an untouched document, which a file can be opened into
    /// instead of a new window. A window is taken off the moment a file is queued for it.
    busy: HashSet<String>,
    next: u32,
}

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

/// A window's webview calls this once it is listening, and gets the files queued for it.
#[tauri::command]
fn take_pending_files(window: tauri::Window, state: tauri::State<'_, Windows>) -> Vec<String> {
    eprintln!("jockoshop: {} connected", window.label());
    state.0.lock().unwrap().pending.remove(window.label()).unwrap_or_default()
}

/// Told by a window whether its document has unsaved changes, and whether it is
/// untouched (nothing opened into it, nothing drawn) so a file may replace it.
#[tauri::command]
fn set_doc_state(window: tauri::Window, state: tauri::State<'_, Windows>, dirty: bool, untouched: bool) {
    let label = window.label().to_string();
    let mut s = state.0.lock().unwrap();
    if dirty { s.dirty.insert(label.clone()); } else { s.dirty.remove(&label); }
    // a window still to open its queued files is not free, whatever it says before it has asked for them
    if untouched && !s.pending.contains_key(&label) { s.busy.remove(&label); } else { s.busy.insert(label); }
}

/// Whether any window has unsaved changes: an update is not installed over them.
#[tauri::command]
fn unsaved_windows(state: tauri::State<'_, Windows>) -> usize {
    state.0.lock().unwrap().dirty.len()
}

/// Restart into the version just installed — unless a window has gained unsaved
/// changes since the app last looked, in which case nothing happens (false) and
/// the new version starts next time.
#[tauri::command]
fn restart_if_saved(app: tauri::AppHandle, state: tauri::State<'_, Windows>) -> bool {
    if !state.0.lock().unwrap().dirty.is_empty() {
        return false;
    }
    app.restart()
}

/// A new window for a new document, or one per file to open.
///
/// Async so the window is not built while the main thread waits on this call
/// (that deadlocks on Windows).
#[tauri::command]
async fn open_window(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return new_window(&app, Vec::new()).map_err(|e| e.to_string());
    }
    for p in paths {
        new_window(&app, vec![p]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Build a window like the first one in tauri.conf.json, a step down and right
/// of the window in front, and queue `paths` for it to open.
fn new_window(app: &tauri::AppHandle, paths: Vec<String>) -> tauri::Result<()> {
    let label = {
        let state = app.state::<Windows>();
        let mut s = state.0.lock().unwrap();
        s.next += 1;
        let label = format!("doc{}", s.next);
        s.busy.insert(label.clone());
        if !paths.is_empty() { s.pending.insert(label.clone(), paths); }
        label
    };
    let mut conf = app.config().app.windows.first().cloned().unwrap_or_default();
    conf.label = label;
    let front = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
    let window = WebviewWindowBuilder::from_config(app, &conf)?.build()?;
    if let Some(front) = front {
        if let (Ok(pos), Ok(scale)) = (front.outer_position(), front.scale_factor()) {
            let step = (28.0 * scale) as i32;
            let _ = window.set_position(tauri::PhysicalPosition::new(pos.x + step, pos.y + step));
        }
    }
    Ok(())
}

/// Files from Finder or the command line: into a window with an untouched
/// document if there is one, else each into a window of its own. A window drains
/// its queue with `take_pending_files`, on the nudge or when it starts —
/// whichever comes first.
fn open_paths(app: &tauri::AppHandle, mut paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let reuse = {
        let state = app.state::<Windows>();
        let mut s = state.0.lock().unwrap();
        let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
        labels.sort();
        let free = labels.into_iter().find(|l| !s.busy.contains(l));
        free.map(|label| {
            s.busy.insert(label.clone());
            s.pending.entry(label.clone()).or_default().push(paths.remove(0));
            label
        })
    };
    if let Some(label) = reuse {
        let _ = app.emit_to(label.as_str(), "open-files", ());
    }
    for p in paths {
        if let Err(e) = new_window(app, vec![p]) {
            eprintln!("jockoshop: could not open a window: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Windows::default())
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, take_pending_files, set_doc_state, open_window, open_url,
            unsaved_windows, restart_if_saved,
            clip::clipboard_write, clip::clipboard_read,
            remote::remote_probe, remote::remote_list, remote::remote_upload,
        ])
        .setup(|app| {
            // files given on the command line (Windows / Linux; macOS uses the Opened event)
            let args: Vec<String> = std::env::args().skip(1).filter(|a| std::path::Path::new(a).is_file()).collect();
            open_paths(app.handle(), args);
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.state::<Windows>().0.lock().unwrap().dirty.contains(window.label()) {
                        api.prevent_close();
                        // the app asks, then calls window.destroy()
                        let _ = window.emit_to(window.label(), "close-requested", ());
                    }
                }
                WindowEvent::Destroyed => {
                    let state = window.state::<Windows>();
                    let mut s = state.0.lock().unwrap();
                    let label = window.label();
                    s.pending.remove(label);
                    s.dirty.remove(label);
                    s.busy.remove(label);
                }
                _ => {}
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
