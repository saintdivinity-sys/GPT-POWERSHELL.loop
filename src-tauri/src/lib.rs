mod storage_cleaner;
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
    server_stopping: bool,
    timeout_seconds: u64,
    high_active: bool,
    execution_active: bool,
    execution_started_at_ms: Option<i64>,
    has_last_accepted_command: bool,
    last_accepted_command: Option<String>,
}

#[tauri::command]
async fn set_mode(state: tauri::State<'_, SharedState>, mode: String) -> Result<(), String> {
    let mut guard = state.lock().await;
    if guard.server_stopping {
        return Err("Bridge is stopping".into());
    }
    guard.set_mode(&mode)?;
    guard.push_console("status", format!("Mode changed → {mode}"));
    Ok(())
}

#[tauri::command]
async fn replay_last_command(
    state: tauri::State<'_, SharedState>,
    as_high: bool,
    expected_command: String,
    confirmed: bool,
) -> Result<String, String> {
    bridge::replay_accepted_command(
        state.inner().clone(),
        as_high,
        expected_command,
        confirmed,
    )
    .await
}
#[tauri::command]
async fn get_state(state: tauri::State<'_, SharedState>) -> Result<BridgeSnapshot, String> {
    let guard = state.lock().await;
    Ok(BridgeSnapshot {
        mode: guard.mode.clone(),
        port: guard.port,
        server_started: guard.server_started,
        server_stopping: guard.server_stopping,
        timeout_seconds: guard.timeout_seconds,
        high_active: guard.high_active,
        execution_active: guard.execution_active,
        execution_started_at_ms: guard.execution_started_at_ms,
        has_last_accepted_command: guard.last_accepted_command.is_some(),
        last_accepted_command: guard.last_accepted_command.clone(),
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
    if !(47177..=47179).contains(&port) {
        return Err(
            "GP channel port must be 47177, 47178, or 47179".into()
        );
    }

    {
        let guard = state.lock().await;
        if guard.server_stopping {
            return Err("Bridge is stopping; wait for shutdown".into());
        }

        if guard.server_started {
            return Ok(format!(
                "Bridge already listening on ws://127.0.0.1:{}",
                guard.port
            ));
        }
    }

    // Bind before claiming that the bridge is online.
    let listener = tokio::net::TcpListener::bind(
        ("127.0.0.1", port)
    )
    .await
    .map_err(|error| {
        format!("Cannot start GP bridge on port {port}: {error}")
    })?;

    let (shutdown_sender, shutdown_receiver) =
        tokio::sync::watch::channel(false);

    let (done_sender, done_receiver) =
        tokio::sync::watch::channel(false);

    {
        let mut guard = state.lock().await;

        // Recheck after binding, to prevent concurrent start/stop races.
        if guard.server_started || guard.server_stopping {
            return Err("Bridge already running or stopping".into());
        }

        guard.port = port;
        guard.shutdown_sender = Some(shutdown_sender);
        guard.shutdown_done = Some(done_receiver);
        guard.server_stopping = false;
        guard.server_started = true;

        if guard.mode == "stopped" {
            guard.set_mode("step")?;
        }

        let mode = guard.mode.clone();
        guard.push_console(
            "status",
            format!(
                "Bridge confirmed on ws://127.0.0.1:{port} - Mode: {mode}"
            ),
        );
    }

    let cloned = state.inner().clone();

    tauri::async_runtime::spawn(async move {
        let result =
            bridge::serve_bound(cloned.clone(), listener, shutdown_receiver).await;

        {
            let mut guard = cloned.lock().await;
            let requested_stop = guard.server_stopping;

            guard.server_started = false;
            guard.server_stopping = false;
            guard.shutdown_sender = None;
            guard.shutdown_done = None;

            if requested_stop {
                guard.set_mode("stopped").ok();
                guard.push_console("status", "Bridge stopped; listener and clients closed");
            } else {
                guard.set_mode("paused").ok();

                let reason = result
                    .err()
                    .unwrap_or_else(|| "Server task ended unexpectedly".into());

                guard.push_console(
                    "critical",
                    format!("Bridge server stopped unexpectedly: {reason}")
                );
            }
        }

        // Acknowledge only after the socket and client tasks are gone.
        let _ = done_sender.send(true);
    });
    Ok(format!("Listening on ws://127.0.0.1:{port}"))
}

/// GP_GRACEFUL_STOP_V1
#[tauri::command]
async fn stop_bridge(
    state: tauri::State<'_, SharedState>,
) -> Result<String, String> {
    let mut done_receiver = {
        let mut guard = state.lock().await;

        if guard.server_stopping {
            return Err("Bridge shutdown is already in progress".into());
        }

        if !guard.server_started {
            return Ok("Bridge is already offline".into());
        }

        if guard.execution_active {
            return Err(
                "Cannot stop Bridge while a PowerShell command is running".into()
            );
        }

        let sender = guard
            .shutdown_sender
            .as_ref()
            .cloned()
            .ok_or_else(|| "Bridge shutdown sender is missing".to_string())?;

        let receiver = guard
            .shutdown_done
            .as_ref()
            .cloned()
            .ok_or_else(|| "Bridge shutdown acknowledgment is missing".to_string())?;

        // Prevent new commands from passing the mode gate while closing.
        guard.server_stopping = true;
        guard.set_mode("stopped")?;
        guard.push_console("status", "Bridge shutdown requested");

        // send_replace works even if the server task already exited.
        sender.send_replace(true);

        receiver
    };

    tokio::time::timeout(Duration::from_secs(8), async {
        while !*done_receiver.borrow() {
            done_receiver
                .changed()
                .await
                .map_err(|_| "Bridge shutdown acknowledgment channel closed".to_string())?;
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "Timed out waiting for Bridge to release its port".to_string())??;

    Ok("Bridge stopped; port released".into())
}
pub fn run() {
    let shared: SharedState = Arc::new(Mutex::new(BridgeState::default()));

    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            storage_cleaner::storage_drives,
            storage_cleaner::storage_list_directory,
            storage_cleaner::storage_scan_folder,
            set_mode,
            replay_last_command,
            get_state,
            get_console_log,
            clear_console_log,
            show_alert_overlay,
            start_bridge,
            stop_bridge
        ])
        .run(tauri::generate_context!())
        .expect("error while running GPT-POWERSHELL.loop");
}
