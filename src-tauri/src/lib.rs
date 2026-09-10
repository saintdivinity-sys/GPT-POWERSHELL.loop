mod bridge;
mod safety;

use bridge::{BridgeState, ConsoleEntry, SharedState};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tauri::Manager;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Serialize)]
struct BridgeSnapshot {
    mode: String,
    port: u16,
    server_started: bool,
    timeout_seconds: u64,
}

#[tauri::command]
async fn set_mode(state: tauri::State<'_, SharedState>, mode: String) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.set_mode(&mode)?;
    guard.push_console("status", format!("Mode changed → {mode}"));
    Ok(())
}

#[tauri::command]
async fn get_state(state: tauri::State<'_, SharedState>) -> Result<BridgeSnapshot, String> {
    let guard = state.lock().await;
    Ok(BridgeSnapshot {
        mode: guard.mode.clone(),
        port: guard.port,
        server_started: guard.server_started,
        timeout_seconds: guard.timeout_seconds,
    })
}

#[tauri::command]
async fn get_console_log(state: tauri::State<'_, SharedState>) -> Result<Vec<ConsoleEntry>, String> {
    let guard = state.lock().await;
    Ok(guard.console_entries())
}

#[tauri::command]
async fn clear_console_log(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.clear_console();
    Ok(())
}

#[tauri::command]
async fn show_alert_overlay(app: tauri::AppHandle, kind: String) -> Result<usize, String> {
    match kind.as_str() {
        "error" | "attention" | "critical" => {}
        _ => return Err(format!("unsupported alert kind: {kind}")),
    }

    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    if monitors.is_empty() {
        return Err("no monitors available for alert overlay".into());
    }

    let monitor_count = monitors.len();
    let token = Uuid::new_v4().simple().to_string();
    let kind_json = serde_json::to_string(&kind).map_err(|error| error.to_string())?;
    let init_script = format!("window.__GPTPS_OVERLAY_KIND__ = {kind_json};");
    let mut labels = Vec::with_capacity(monitor_count);

    for (index, monitor) in monitors.iter().enumerate() {
        let label = format!("gptps-alert-{token}-{index}");
        let size = monitor.size();
        let position = monitor.position();

        // The visual occupies about 20% of each monitor width and stays centered.
        let overlay_width = ((size.width as f64 * 0.20).round() as u32).max(240);
        let overlay_height = ((size.height as f64 * 0.26).round() as u32).max(180);
        let x = position.x + (size.width.saturating_sub(overlay_width) / 2) as i32;
        let y = position.y + (size.height.saturating_sub(overlay_height) / 2) as i32;

        let window = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("GPTPS alert")
        .visible(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .shadow(false)
        .initialization_script(init_script.clone())
        .build()
        .map_err(|error| error.to_string())?;

        window
            .set_size(tauri::PhysicalSize::new(overlay_width, overlay_height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;

        labels.push(label);
    }

    let close_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1950)).await;
        for label in labels {
            if let Some(window) = close_app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
    });

    Ok(monitor_count)
}

#[tauri::command]
async fn start_bridge(
    state: tauri::State<'_, SharedState>,
    port: u16,
) -> Result<String, String> {
    {
        let mut guard = state.lock().await;
        if guard.server_started {
            return Ok(format!("Bridge already listening on ws://127.0.0.1:{}", guard.port));
        }
        guard.port = port;
        guard.server_started = true;
        if guard.mode == "stopped" {
            guard.set_mode("step")?;
        }
        let mode = guard.mode.clone();
        guard.push_console("status", format!("Bridge listening on ws://127.0.0.1:{port} · Mode: {mode}"));
    }

    let cloned = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = bridge::serve(cloned.clone(), port).await {
            cloned.lock().await.push_console("stderr", format!("Bridge server error: {error}"));
            eprintln!("bridge server error: {error}");
        }
    });

    Ok(format!("Listening on ws://127.0.0.1:{port}"))
}

pub fn run() {
    let shared: SharedState = Arc::new(Mutex::new(BridgeState::default()));

    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            set_mode,
            get_state,
            get_console_log,
            clear_console_log,
            show_alert_overlay,
            start_bridge
        ])
        .run(tauri::generate_context!())
        .expect("error while running GPT-POWERSHELL.loop");
}
