use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use percent_encoding::percent_decode_str;
use tauri::{
    Emitter, Manager, State,
    ipc::{InvokeBody, Request, Response},
};

mod window_state;

/// Files the OS asked us to open before the UI was ready to receive them.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

/// Reads a file and returns its bytes as a raw (non-JSON) IPC response.
/// Async so large files are read off the main thread.
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::read(&path)
            .map(Response::new)
            .map_err(|e| format!("Could not read “{path}”: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes the raw request body to the path given in the `x-path` header.
#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Expected binary data".into());
    };
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing destination path")?;
    let path = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned();
    let path = PathBuf::from(path);
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_atomically(&path, &data)
            .map_err(|e| format!("Could not save “{}”: {e}", path.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes to a temporary file next to the target and renames it into place,
/// so a failed save can never leave a half-written PDF behind.
fn write_atomically(path: &Path, data: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// An installed font face, as reported to the UI (which does the matching).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledFont {
    path: String,
    /// Face index inside a font collection (.ttc); 0 for single fonts.
    index: u32,
    postscript_name: String,
    family: String,
    weight: u16,
    italic: bool,
    monospaced: bool,
}

static INSTALLED_FONTS: OnceLock<Vec<InstalledFont>> = OnceLock::new();

/// Scans the system font directories once (macOS, Windows, and fontconfig dirs on Linux).
fn installed_fonts() -> &'static [InstalledFont] {
    INSTALLED_FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // On macOS, office suites keep their fonts inside the app bundle (on Windows
        // and Linux they're installed system-wide). Documents made with them use
        // these fonts (Calibri, Cambria, Carlito, Liberation…), so include them.
        #[cfg(target_os = "macos")]
        for dir in [
            "/Applications/Microsoft Word.app/Contents/Resources/DFonts",
            "/Applications/Microsoft Excel.app/Contents/Resources/DFonts",
            "/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts",
            "/Applications/Microsoft Outlook.app/Contents/Resources/DFonts",
            "/Applications/LibreOffice.app/Contents/Resources/fonts/truetype",
        ] {
            if Path::new(dir).is_dir() {
                db.load_fonts_dir(dir);
            }
        }
        let mut fonts: Vec<InstalledFont> = db
            .faces()
            .filter_map(|face| {
                let path = match &face.source {
                    fontdb::Source::File(p) | fontdb::Source::SharedFile(p, _) => p,
                    _ => return None,
                };
                let family = face.families.first()?.0.clone();
                // Names starting with "." are private system UI fonts on macOS.
                if family.starts_with('.') || face.post_script_name.is_empty() {
                    return None;
                }
                Some(InstalledFont {
                    path: path.to_string_lossy().into_owned(),
                    index: face.index,
                    postscript_name: face.post_script_name.clone(),
                    family,
                    weight: face.weight.0,
                    italic: face.style != fontdb::Style::Normal,
                    monospaced: face.monospaced,
                })
            })
            .collect();
        fonts.sort_by(|a, b| {
            a.family
                .to_lowercase()
                .cmp(&b.family.to_lowercase())
                .then(a.weight.cmp(&b.weight))
                .then(a.italic.cmp(&b.italic))
        });
        fonts
    })
}

/// Lists installed font faces. Font bytes are fetched with `read_file`.
#[tauri::command]
async fn list_fonts() -> Result<Vec<InstalledFont>, String> {
    tauri::async_runtime::spawn_blocking(|| installed_fonts().to_vec())
        .await
        .map_err(|e| e.to_string())
}

/// Returns (and clears) files passed on the command line or via "Open With".
#[tauri::command]
fn take_pending_files(pending: State<'_, PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

fn is_pdf(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".pdf")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial: Vec<String> = std::env::args().skip(1).filter(|a| is_pdf(a)).collect();
    // Warm the font list in the background so the first text edit doesn't wait for it.
    std::thread::spawn(|| {
        installed_fonts();
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window(window_state::MAIN_WINDOW) {
                #[cfg(not(target_os = "macos"))]
                let _ = window.set_decorations(false);
                window_state::restore(&window);
            }
            Ok(())
        })
        .manage(PendingFiles(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_fonts,
            take_pending_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                window_state::save(app);
            }
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .filter(|p| is_pdf(p))
                    .collect();
                if paths.is_empty() {
                    return;
                }
                // Queue them for a UI that is still starting, and notify a running one.
                app.state::<PendingFiles>()
                    .0
                    .lock()
                    .unwrap()
                    .extend(paths.iter().cloned());
                let _ = app.emit("open-files", paths);
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_fonts() {
        let fonts = installed_fonts();
        // Every desktop OS ships fonts; make sure the scan found some and they're well formed.
        assert!(!fonts.is_empty(), "no system fonts found");
        assert!(
            fonts
                .iter()
                .all(|f| !f.family.is_empty() && !f.postscript_name.is_empty())
        );
        #[cfg(target_os = "macos")]
        assert!(
            fonts
                .iter()
                .any(|f| f.postscript_name == "Helvetica-Bold" && f.weight >= 600)
        );
        #[cfg(target_os = "macos")]
        if Path::new("/Applications/LibreOffice.app/Contents/Resources/fonts/truetype").is_dir() {
            assert!(fonts.iter().any(|f| f.postscript_name == "Carlito-Bold"));
        }
    }

    #[test]
    fn atomic_write_replaces_file() {
        let dir = std::env::temp_dir().join(format!("astatine-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.pdf");
        write_atomically(&path, b"first").unwrap();
        write_atomically(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "temporary file left behind"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
