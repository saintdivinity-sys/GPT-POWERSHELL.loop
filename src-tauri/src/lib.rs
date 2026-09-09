mod bridge;
mod safety;

use bridge::{BridgeState, SharedState};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;

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
    guard.set_mode(&mode)
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
            guard.mode = "step".into();
        }
    }

    let cloned = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = bridge::serve(cloned, port).await {
            eprintln!("bridge server error: {error}");
        }
    });

    Ok(format!("Listening on ws://127.0.0.1:{port}"))
}

pub fn run() {
    let shared: SharedState = Arc::new(Mutex::new(BridgeState::default()));

    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![set_mode, get_state, start_bridge])
        .run(tauri::generate_context!())
        .expect("error while running GPT-POWERSHELL.loop");
}
