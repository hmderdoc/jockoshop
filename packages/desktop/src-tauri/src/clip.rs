//! The system clipboard, with types a webview can't reach.
//!
//! Moebius keeps a selection as JSON in the HTML slot (`electron.clipboard`),
//! PabloDraw as bytes under its own type, "pablo" (Eto passes the name to
//! NSPasteboard as it is). Copy writes every representation at once, as one
//! clipboard item, so whichever editor pastes finds the one it reads; the app
//! decides which of them to paste.

#[cfg(not(target_os = "macos"))]
use clipboard_rs::ClipboardContent;
use clipboard_rs::{Clipboard, ClipboardContext, ContentFormat};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct ClipWrite {
    text: Option<String>,
    html: Option<String>,
    /// (type name, bytes)
    #[serde(default)]
    custom: Vec<(String, Vec<u8>)>,
}

#[derive(Serialize, Default)]
pub struct ClipRead {
    text: Option<String>,
    html: Option<String>,
    /// the asked-for custom types that are on the clipboard
    custom: HashMap<String, Vec<u8>>,
}

fn context() -> Result<ClipboardContext, String> {
    ClipboardContext::new().map_err(|e| format!("clipboard: {e}"))
}

/// Replace the clipboard with these representations of one thing.
///
/// On a Mac this goes through NSPasteboard's own setters rather than an
/// NSPasteboardItem (which clipboard-rs uses): an item silently drops a type
/// that is not a UTI, and "pablo" is not one. The pasteboard's setters take it,
/// as they do for Eto, filing it under "pablo" and a dyn. UTI alike.
#[tauri::command]
pub fn clipboard_write(clip: ClipWrite) -> Result<(), String> {
    if clip.text.is_none() && clip.html.is_none() && clip.custom.is_empty() {
        return Err("nothing to put on the clipboard".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString};
        use objc2_foundation::{NSData, NSString};
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let mut ok = true;
        if let Some(t) = &clip.text { ok &= pb.setString_forType(&NSString::from_str(t), unsafe { NSPasteboardTypeString }); }
        if let Some(h) = &clip.html { ok &= pb.setString_forType(&NSString::from_str(h), unsafe { NSPasteboardTypeHTML }); }
        for (kind, bytes) in &clip.custom {
            ok &= pb.setData_forType(Some(&NSData::with_bytes(bytes)), &NSString::from_str(kind));
        }
        return if ok { Ok(()) } else { Err("clipboard: the pasteboard refused a type".into()) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut items = Vec::new();
        if let Some(t) = clip.text { items.push(ClipboardContent::Text(t)); }
        if let Some(h) = clip.html { items.push(ClipboardContent::Html(h)); }
        for (kind, bytes) in clip.custom { items.push(ClipboardContent::Other(kind, bytes)); }
        context()?.set(items).map_err(|e| format!("clipboard: {e}"))
    }
}

/// Whatever of text, HTML and the named custom types the clipboard holds.
#[tauri::command]
pub fn clipboard_read(custom: Vec<String>) -> Result<ClipRead, String> {
    let ctx = context()?;
    let mut out = ClipRead::default();
    if ctx.has(ContentFormat::Text) { out.text = ctx.get_text().ok(); }
    if ctx.has(ContentFormat::Html) { out.html = ctx.get_html().ok(); }
    for kind in custom {
        if ctx.has(ContentFormat::Other(kind.clone())) {
            if let Ok(bytes) = ctx.get_buffer(&kind) {
                out.custom.insert(kind, bytes);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real clipboard, so it only runs when asked: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn round_trips_through_the_system_clipboard() {
        clipboard_write(ClipWrite {
            text: Some("█A".into()),
            html: Some("<meta charset='utf-8'>{\"columns\":2}".into()),
            custom: vec![("pablo".into(), vec![2, 0, 0, 0, 1, 0, 0, 0, 65]), ("org.hmderdoc.jockoshop.cells".into(), vec![0, 255])],
        }).unwrap();
        let r = clipboard_read(vec!["pablo".into(), "org.hmderdoc.jockoshop.cells".into(), "absent.type".into()]).unwrap();
        assert_eq!(r.text.as_deref(), Some("█A"));
        assert_eq!(r.html.as_deref(), Some("<meta charset='utf-8'>{\"columns\":2}"));
        assert_eq!(r.custom.get("pablo"), Some(&vec![2, 0, 0, 0, 1, 0, 0, 0, 65]));
        assert_eq!(r.custom.get("org.hmderdoc.jockoshop.cells"), Some(&vec![0, 255]));
        assert!(!r.custom.contains_key("absent.type"));
    }
}
