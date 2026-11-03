//! Reopens the main window the way it was left: size, position, and whether it
//! was maximized or full screen.
//!
//! The size and position kept are those from the last time the window was
//! neither maximized, full screen nor minimized, so a window that reopens
//! maximized still un-maximizes to where it was before.

use std::{
    fs,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow, WindowEvent,
};

use crate::write_atomically;

/// Label of the window from `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";
const FILE_NAME: &str = "window-state.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    maximized: bool,
    fullscreen: bool,
}

struct Tracker {
    state: Mutex<WindowState>,
    maximize_after_fullscreen: AtomicBool,
}

pub fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    let saved = load(window.app_handle());
    if let Some(s) = saved {
        let _ = window.set_size(LogicalSize::new(s.width, s.height));
        if title_bar_on_screen(window, &s) {
            let _ = window.set_position(PhysicalPosition::new(s.x, s.y));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();

    let state = match saved {
        Some(s) => {
            if s.fullscreen {
                let _ = window.set_fullscreen(true);
            } else if s.maximized {
                let _ = window.maximize();
            }
            s
        }
        None => {
            let mut s = WindowState::default();
            update(window, &mut s);
            s
        }
    };
    window.manage(Tracker {
        state: Mutex::new(state),
        maximize_after_fullscreen: AtomicBool::new(state.fullscreen && state.maximized),
    });

    let w = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
        ) {
            refresh(&w);
        }
    });
}

pub fn save<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        refresh(&window);
    }
    let Some(tracker) = app.try_state::<Tracker>() else {
        return;
    };
    let state = *tracker.state.lock().unwrap();
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let Ok(json) = serde_json::to_vec_pretty(&state) else {
        return;
    };
    let _ = fs::create_dir_all(&dir).and_then(|()| write_atomically(&dir.join(FILE_NAME), &json));
}

fn load<R: Runtime>(app: &AppHandle<R>) -> Option<WindowState> {
    let path = app.path().app_config_dir().ok()?.join(FILE_NAME);
    let state: WindowState = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let valid = |v: f64| v.is_finite() && v > 0.0;
    (valid(state.width) && valid(state.height)).then_some(state)
}

fn refresh<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(tracker) = window.try_state::<Tracker>() else {
        return;
    };
    if tracker.maximize_after_fullscreen.load(Ordering::Relaxed)
        && window.is_fullscreen().is_ok_and(|fullscreen| !fullscreen)
    {
        tracker
            .maximize_after_fullscreen
            .store(false, Ordering::Relaxed);
        let _ = window.maximize();
    }
    // Don't hold the lock while querying the window.
    let mut state = *tracker.state.lock().unwrap();
    update(window, &mut state);
    *tracker.state.lock().unwrap() = state;
}

fn update<R: Runtime>(window: &WebviewWindow<R>, state: &mut WindowState) {
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    let Ok(fullscreen) = window.is_fullscreen() else {
        return;
    };
    state.fullscreen = fullscreen;
    if fullscreen {
        return;
    }

    let Ok(maximized) = window.is_maximized() else {
        return;
    };
    state.maximized = maximized;
    if maximized {
        return;
    }

    if let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        let size = size.to_logical::<f64>(scale);
        if size.width > 0.0 && size.height > 0.0 {
            (state.x, state.y) = (position.x, position.y);
            (state.width, state.height) = (size.width, size.height);
        }
    }
}

fn title_bar_on_screen<R: Runtime>(window: &WebviewWindow<R>, state: &WindowState) -> bool {
    let Ok(scale) = window.scale_factor() else {
        return false;
    };
    let width = (state.width * scale) as i32;
    let min_visible = (100.0 * scale) as i32;
    window.available_monitors().is_ok_and(|monitors| {
        monitors.iter().any(|m| {
            let (pos, size) = (m.position(), m.size());
            let top = pos.y..pos.y + size.height as i32;
            let overlap = (state.x + width).min(pos.x + size.width as i32) - state.x.max(pos.x);
            top.contains(&state.y) && overlap >= min_visible
        })
    })
}
