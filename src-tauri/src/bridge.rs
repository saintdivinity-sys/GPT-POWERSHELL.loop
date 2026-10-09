use crate::safety;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::PathBuf, process::{Command as StdCommand, Stdio}, sync::Arc, time::Duration};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{watch, Mutex},
    task::JoinSet,
    time::timeout,
};
use tokio_tungstenite::{
    accept_async,
    tungstenite::Message,
    WebSocketStream,
};
use uuid::Uuid;

pub type SharedState = Arc<Mutex<BridgeState>>;

#[derive(Debug, Clone, Serialize)]
pub struct ConsoleEntry {
    id: u64,
    at: String,
    kind: String,
    text: String,
}

#[derive(Debug)]
pub struct BridgeState {
    pub mode: String,
    pub port: u16,
    pub server_started: bool,
    pub timeout_seconds: u64,
    pub high_active: bool,
    pub execution_active: bool,
    pub execution_started_at_ms: Option<i64>,
    pub last_accepted_command: Option<String>,
    pub last_accepted_marker: Option<String>,
    pub server_stopping: bool,
    pub shutdown_sender: Option<watch::Sender<bool>>,
    pub shutdown_done: Option<watch::Receiver<bool>>,
    pub attention_armed_at_ms: Option<i64>,
    console_log: VecDeque<ConsoleEntry>,
    next_console_id: u64,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            mode: "stopped".into(),
            port: 47177,
            server_started: false,
            timeout_seconds: 300,
            high_active: false,
            execution_active: false,
            execution_started_at_ms: None,
            last_accepted_command: None,
            last_accepted_marker: None,
            server_stopping: false,
            shutdown_sender: None,
            shutdown_done: None,
            attention_armed_at_ms: None,
            console_log: VecDeque::new(),
            next_console_id: 1,
        }
    }
}

impl BridgeState {
    pub fn set_mode(&mut self, mode: &str) -> Result<(), String> {
        match mode {
            "step" | "auto_safe" | "paused" | "stopped" => {
                self.mode = mode.to_string();
                self.attention_armed_at_ms = if mode == "step" || mode == "auto_safe" {
                    Some(Utc::now().timestamp_millis())
                } else {
                    None
                };
                Ok(())
            }
            _ => Err("invalid mode".into()),
        }
    }

    pub fn push_console(&mut self, kind: &str, text: impl Into<String>) {
        let text = text.into();
        if text.trim().is_empty() {
            return;
        }

        self.console_log.push_back(ConsoleEntry {
            id: self.next_console_id,
            at: Utc::now().to_rfc3339(),
            kind: kind.to_string(),
            text,
        });
        self.next_console_id += 1;

        while self.console_log.len() > 400 {
            self.console_log.pop_front();
        }
    }

    pub fn console_entries(&self) -> Vec<ConsoleEntry> {
        self.console_log.iter().cloned().collect()
    }

    pub fn clear_console(&mut self) {
        self.console_log.clear();
    }
}

/// Explicit user-initiated replay of the last accepted command.
/// The UI must request a fresh confirmation for each replay.
pub async fn replay_accepted_command(
    state: SharedState,
    as_high: bool,
    expected_command: String,
    confirmed: bool,
) -> Result<String, String> {
    if !confirmed {
        return Err("Replay requires explicit user confirmation".into());
    }

    // Atomically validate and reserve the single execution slot.
    let (command, timeout_seconds) = {
        let mut guard = state.lock().await;

        if !guard.server_started {
            return Err("Cannot replay: bridge is offline".into());
        }

        if guard.execution_active {
            return Err("Cannot replay: PowerShell is already executing".into());
        }

        if guard.mode == "stopped" {
            return Err("Cannot replay while STOP LOOP is active".into());
        }

        let command = guard
            .last_accepted_command
            .clone()
            .ok_or_else(|| "No accepted command available for replay".to_string())?;

        // Reject stale UI requests, even if a newer command arrived
        // between opening the confirmation and clicking Yes.
        if command != expected_command {
            return Err(
                "Last accepted command changed; review it before replaying".into()
            );
        }

        let marker = guard
            .last_accepted_marker
            .as_deref()
            .ok_or_else(|| "Original GP channel marker is missing".to_string())?;

        let suffix = marker
            .strip_prefix("GPTPS_EXEC")
            .or_else(|| marker.strip_prefix("GPTPS_HIGH"))
            .ok_or_else(|| "Original GP marker is invalid".to_string())?;

        let original_channel: u16 = match suffix {
            "" | ":1" => 1,
            ":2" => 2,
            ":3" => 3,
            _ => return Err("Original GP channel is invalid".into()),
        };

        if guard.port != 47176 + original_channel {
            return Err("Original command belongs to a different channel".into());
        }

        let decision = safety::classify(&command);

        if !decision.allowed {
            guard.push_console(
                "critical",
                format!("Manual replay blocked: {}", decision.reason),
            );
            return Err(format!("Safety check rejected replay: {}", decision.reason));
        }

        guard.execution_active = true;
        guard.execution_started_at_ms = Some(Utc::now().timestamp_millis());
        guard.high_active = as_high;

        let replay_mode = if as_high { "HIGH" } else { "EXEC" };

        guard.push_console(
            "status",
            format!("Manual {replay_mode} replay started"),
        );
        guard.push_console("command", command.clone());

        (command, guard.timeout_seconds)
    };

    let result = if as_high {
        run_powershell_high(&command).await
    } else {
        run_powershell(&command, timeout_seconds).await
    };

    match result {
        Ok(result) => {
            let summary = match &result {
                ServerMessage::CommandResult {
                    cycle_id,
                    exit_code,
                    stdout,
                    stderr,
                    ..
                } => {
                    let mut guard = state.lock().await;

                    guard.execution_active = false;
                    guard.execution_started_at_ms = None;
                    guard.high_active = false;

                    let label = if as_high { "HIGH" } else { "EXEC" };

                    guard.push_console(
                        "meta",
                        format!(
                            "Manual {label} replay cycle_id: {cycle_id}; exit_code: {exit_code}"
                        ),
                    );

                    if !stdout.trim().is_empty() {
                        guard.push_console("stdout", stdout.clone());
                    }

                    if !stderr.trim().is_empty() {
                        guard.push_console("stderr", stderr.clone());
                    }

                    guard.push_console(
                        "status",
                        format!("Manual {label} replay finished; exit_code: {exit_code}"),
                    );

                    format!(
                        "Manual {label} replay completed; cycle_id={cycle_id}; exit_code={exit_code}"
                    )
                }
                _ => {
                    let mut guard = state.lock().await;
                    guard.execution_active = false;
                    guard.execution_started_at_ms = None;
                    guard.high_active = false;

                    return Err("PowerShell returned an unexpected result".into());
                }
            };

            // Manual replays are recorded locally. They are not silently
            // presented to ChatGPT as fresh browser-command responses.
            append_session_log(&result).await.ok();

            Ok(summary)
        }
        Err(error) => {
            let mut guard = state.lock().await;

            guard.execution_active = false;
            guard.execution_started_at_ms = None;
            guard.high_active = false;
            guard.set_mode("paused").ok();

            guard.push_console(
                "critical",
                format!("Manual replay failed: {error}"),
            );

            Err(error)
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Hello { page_url: Option<String> },
    AssistantCommand {
        command: String,
        marker: String,
        assistant_text: Option<String>,
    },
    AttentionRequired {
        assistant_text: Option<String>,
        observed_at_ms: Option<i64>,
    },
    Ping,
}

#[derive(Debug, Serialize)]
struct ImageAttachment {
    name: String,
    mime_type: String,
    base64_data: String,
    bytes: usize,
    channel: u8,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Hello { version: &'static str, mode: String },
    Pong,
    Paused { reason: String },
    Blocked { reason: String, level: String },
    CommandResult {
        cycle_id: String,
        exit_code: i32,
        stdout: String,
        stderr: String,
        started_at: String,
        finished_at: String,
        attachments: Vec<ImageAttachment>,
        attachment_errors: Vec<String>,
    },
    Error { message: String },
}

/// GP_GRACEFUL_STOP_V1
/// Own both the listening socket and every accepted client task.
/// Returning from this function means the listener has been dropped
/// and client tasks have been cancelled and joined.
pub async fn serve_bound(
    state: SharedState,
    listener: TcpListener,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut clients = JoinSet::new();

    let outcome = loop {
        tokio::select! {
            biased;

            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break Ok(());
                }
            }

            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let client_state = state.clone();

                        clients.spawn(async move {
                            if let Err(error) =
                                handle_connection(client_state.clone(), stream).await
                            {
                                let mut guard = client_state.lock().await;
                                guard.push_console(
                                    "critical",
                                    format!("WebSocket connection error: {error}")
                                );
                                eprintln!("connection error: {error}");
                            }
                        });
                    }

                    Err(error) => {
                        break Err(error.to_string());
                    }
                }
            }

            _ = clients.join_next(), if !clients.is_empty() => {}
        }
    };

    // Close the listener before reporting shutdown completion.
    drop(listener);

    // No client may remain attached to an offline Bridge.
    clients.abort_all();

    while clients.join_next().await.is_some() {}

    outcome
}
async fn handle_connection(state: SharedState, stream: TcpStream) -> Result<(), String> {
    let ws = accept_async(stream).await.map_err(|error| error.to_string())?;
    let (mut sink, mut source) = ws.split();

    let mode = state.lock().await.mode.clone();
    send_json(&mut sink, &ServerMessage::Hello { version: "0.1.0", mode }).await?;

    while let Some(item) = source.next().await {
        let message = item.map_err(|error| error.to_string())?;
        if !message.is_text() {
            continue;
        }

        let parsed: ClientMessage = match serde_json::from_str(message.to_text().unwrap_or("")) {
            Ok(value) => value,
            Err(error) => {
                state.lock().await.push_console("critical", format!("Protocol parse error: {error}"));
                send_json(&mut sink, &ServerMessage::Error { message: error.to_string() }).await?;
                continue;
            }
        };

        match parsed {
            ClientMessage::Hello { page_url } => {
                if let Some(url) = page_url {
                    state.lock().await.push_console("status", format!("Browser connected: {url}"));
                    eprintln!("browser connected: {url}");
                }
            }
            ClientMessage::Ping => send_json(&mut sink, &ServerMessage::Pong).await?,
            ClientMessage::AttentionRequired { assistant_text, observed_at_ms } => {
                let mut guard = state.lock().await;

                let assistant_has_gp_marker = assistant_text
                    .as_deref()
                    .map(|text| text.contains("GPTPS_EXEC") || text.contains("GPTPS_HIGH"))
                    .unwrap_or(false);

                // App-side fail-safe: a turn that visibly contains a strict GP
                // marker is a command turn, so a stale/legacy extension must
                // never be allowed to turn it into blocking ATTENTION.
                if assistant_has_gp_marker {
                    guard.push_console(
                        "meta",
                        "Ignored ATTENTION because assistant text contains GPTPS_EXEC/GPTPS_HIGH marker.",
                    );
                    continue;
                }

                if !guard.high_active && (guard.mode == "step" || guard.mode == "auto_safe") {
                    let stale = match (observed_at_ms, guard.attention_armed_at_ms) {
                        (Some(observed), Some(armed)) => observed < armed,
                        (None, Some(_)) => true,
                        _ => false,
                    };

                    if stale {
                        guard.push_console(
                            "meta",
                            "Ignored stale ATTENTION candidate that existed before STEP/AUTO SAFE was armed.",
                        );
                        continue;
                    }

                    guard.mode = "paused".into();
                    guard.attention_armed_at_ms = None;
                    guard.push_console(
                        "attention",
                        "ChatGPT requires attention: no GPTPS_EXEC/GPTPS_HIGH command was provided. Loop paused.",
                    );
                    if let Some(text) = assistant_text {
                        let summary = text.trim().replace('\n', " ");
                        if !summary.is_empty() {
                            guard.push_console("meta", format!("Assistant: {}", summary.chars().take(240).collect::<String>()));
                        }
                    }
                }
            }
            ClientMessage::AssistantCommand { command, marker, assistant_text } => {
                let _assistant_text = assistant_text;
                {
                    let mut guard = state.lock().await;
                    guard.push_console("meta", format!("RX command marker: {marker}"));
                    // Accepted commands are recorded at the execution gate.
                }

                // Channel-aware strict markers, retaining legacy channel 1.
                let (marker_kind, channel): (&str, u8) = match marker.split_once(':') {
                    Some((kind, "1")) => (kind, 1),
                    Some((kind, "2")) => (kind, 2),
                    Some((kind, "3")) => (kind, 3),
                    None => (marker.as_str(), 1),
                    _ => ("", 0),
                };
                let is_high = marker_kind == "GPTPS_HIGH";
                if (marker_kind != "GPTPS_EXEC" && !is_high) || channel == 0 {
                    state.lock().await.push_console("critical", "Blocked: strict GPTPS_EXEC/GPTPS_HIGH marker missing");
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: "strict marker missing".into(),
                        level: "red".into(),
                    }).await?;
                    continue;
                }

                // A bridge listening on :47178 cannot execute :1 or :3.
                let configured_port = state.lock().await.port;
                let expected_port = 47176_u16 + u16::from(channel);

                if configured_port != expected_port {
                    state.lock().await.push_console(
                        "critical",
                        format!(
                            "Blocked channel mismatch: marker channel {},                              bridge port {}",
                            channel, configured_port
                        ),
                    );
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: "GP marker channel does not match this bridge".into(),
                        level: "red".into(),
                    }).await?;
                    continue;
                }

                let mode = state.lock().await.mode.clone();
                if mode == "paused" || mode == "stopped" {
                    let reason = format!("bridge mode is {mode}");
                    state.lock().await.push_console("status", format!("Not executed: {reason}"));
                    send_json(&mut sink, &ServerMessage::Paused { reason }).await?;
                    continue;
                }

                let decision = safety::classify(&command);
                if !decision.allowed {
                    let mut guard = state.lock().await;
                    guard.mode = "paused".into();
                    guard.attention_armed_at_ms = None;
                    guard.push_console("critical", format!("Blocked by safety gate: {}", decision.reason));
                    drop(guard);
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: decision.reason,
                        level: decision.level.into(),
                    }).await?;
                    continue;
                }

                // One active PowerShell process per bridge instance.
                // This guard applies to both ordinary EXEC and HIGH.
                let timeout_seconds = {
                    let mut guard = state.lock().await;

                    if guard.execution_active {
                        guard.push_console(
                            "status",
                            "Rejected: another command is already executing",
                        );
                        drop(guard);

                        send_json(
                            &mut sink,
                            &ServerMessage::Blocked {
                                reason: "another command is already executing".into(),
                                level: "orange".into(),
                            },
                        )
                        .await?;

                        continue;
                    }

                    guard.execution_active = true;
                    guard.execution_started_at_ms =
                        Some(Utc::now().timestamp_millis());
                    guard.last_accepted_command = Some(command.clone());
                    guard.last_accepted_marker = Some(marker.clone());
                    guard.push_console("command", command.clone());

                    if is_high {
                        guard.high_active = true;
                        guard.push_console(
                            "status",
                            format!("HIGH started; base mode: {mode}"),
                        );
                    } else {
                        guard.push_console(
                            "status",
                            format!("EXEC started; base mode: {mode}"),
                        );
                    }

                    guard.timeout_seconds
                };
                let execution = if is_high {
                    run_powershell_high(&command).await
                } else {
                    run_powershell(&command, timeout_seconds).await
                };

                match execution {
                    Ok(result) => {
                        if let ServerMessage::CommandResult { cycle_id, exit_code, stdout, stderr, .. } = &result {
                            let failed = *exit_code != 0;
                            let mut guard = state.lock().await;
                            guard.execution_active = false;
                            guard.execution_started_at_ms = None;

                            if is_high {
                                guard.high_active = false;
                                guard.push_console("status", format!("HIGH finished · exit_code: {exit_code}"));
                            }

                            guard.push_console("meta", format!("cycle_id: {cycle_id} · exit_code: {exit_code}"));
                            if !stdout.trim().is_empty() {
                                guard.push_console("stdout", stdout.clone());
                            }
                            if !stderr.trim().is_empty() {
                                guard.push_console("stderr", stderr.clone());
                            }

                            // STEP remains one round-trip. AUTO SAFE stays armed after a
                            // normal command failure; a later assistant turn without an
                            // executable marker will still trigger ATTENTION and pause.
                            if guard.mode == mode {
                                if mode == "step" {
                                    guard.mode = "paused".into();
                                    guard.attention_armed_at_ms = None;
                                    guard.push_console("status", "STEP complete → PAUSED");
                                } else if mode == "auto_safe" {
                                    guard.attention_armed_at_ms = Some(Utc::now().timestamp_millis());
                                    if failed {
                                        guard.push_console("status", "Command failed · AUTO SAFE remains active");
                                    }
                                }
                            } else {
                                let current_mode = guard.mode.clone();
                                guard.push_console(
                                    "meta",
                                    format!("Mode changed while command was running; keeping current mode: {current_mode}"),
                                );
                            }
                        }

                        // Log the ordinary result before adding image bytes.
                        // Base64 image contents must never enter session JSONL.
                        append_session_log(&result).await.ok();

                        let mut result = result;
                        if let ServerMessage::CommandResult {
                            stdout,
                            attachments,
                            attachment_errors,
                            ..
                        } = &mut result {
                            let (images, errors) =
                                read_gp_attachments(stdout, channel).await;
                            *attachments = images;
                            *attachment_errors = errors;
                        }

                        send_json(&mut sink, &result).await?;
                    }
                    Err(message) => {
                        let mut guard = state.lock().await;
                        guard.execution_active = false;
                        guard.execution_started_at_ms = None;
                        guard.high_active = false;
                        guard.mode = "paused".into();
                        guard.attention_armed_at_ms = None;
                        guard.push_console("critical", message.clone());
                        guard.push_console("status", "Execution failure → PAUSED");
                        drop(guard);
                        send_json(&mut sink, &ServerMessage::Error { message }).await?;
                    }
                }
            }
        }
    }

    Ok(())
}

fn powershell_command(executable: &str, script: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn spawn_powershell(script: &str) -> Result<tokio::process::Child, String> {
    match powershell_command("pwsh.exe", script).spawn() {
        Ok(child) => Ok(child),
        Err(pwsh_error) => match powershell_command("powershell.exe", script).spawn() {
            Ok(child) => Ok(child),
            Err(windows_powershell_error) => Err(format!(
                "failed to start PowerShell. pwsh.exe: {pwsh_error}; powershell.exe: {windows_powershell_error}"
            )),
        },
    }
}

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

fn high_powershell_command(executable: &str, script_path: &PathBuf) -> StdCommand {
    let mut command = StdCommand::new(executable);
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script_path);

    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_CONSOLE);

    command
}

fn spawn_high_powershell(script_path: &PathBuf) -> Result<std::process::Child, String> {
    match high_powershell_command("powershell.exe", script_path).spawn() {
        Ok(child) => Ok(child),
        Err(windows_powershell_error) => match high_powershell_command("pwsh.exe", script_path).spawn() {
            Ok(child) => Ok(child),
            Err(pwsh_error) => Err(format!(
                "failed to start HIGH PowerShell. powershell.exe: {windows_powershell_error}; pwsh.exe: {pwsh_error}"
            )),
        },
    }
}

fn decode_high_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }

    String::from_utf8_lossy(bytes).to_string()
}

async fn run_powershell_high(command: &str) -> Result<ServerMessage, String> {
    let cycle_id = Uuid::new_v4().to_string();
    let started = Utc::now();
    let directory = std::env::temp_dir().join(format!("gptps-high-{cycle_id}"));
    let script_path = directory.join("run.ps1");
    let output_path = directory.join("output.txt");

    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("failed to create HIGH temp directory: {error}"))?;

    let output_literal = output_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"$Host.UI.RawUI.WindowTitle = 'GPT-POWERSHELL.loop HIGH'
Write-Host 'GPT-POWERSHELL.loop HIGH' -ForegroundColor Red
Write-Host 'Long-running command from ChatGPT. This window closes automatically when the command finishes.' -ForegroundColor DarkGray
Write-Host ''
$ErrorActionPreference = 'Continue'
$__gptpsErrorCount = $Error.Count
& {{
{command}
}} *>&1 | Tee-Object -FilePath '{output_literal}'
if ($null -ne $LASTEXITCODE) {{
    $__gptpsExit = [int]$LASTEXITCODE
}} elseif ($Error.Count -gt $__gptpsErrorCount) {{
    $__gptpsExit = 1
}} else {{
    $__gptpsExit = 0
}}
exit $__gptpsExit
"#
    );

    tokio::fs::write(&script_path, script.as_bytes())
        .await
        .map_err(|error| format!("failed to write HIGH runner script: {error}"))?;

    let wait_script = script_path.clone();
    let status = tokio::task::spawn_blocking(move || -> Result<std::process::ExitStatus, String> {
        let mut child = spawn_high_powershell(&wait_script)?;
        child.wait().map_err(|error| format!("HIGH PowerShell wait failed: {error}"))
    })
    .await
    .map_err(|error| format!("HIGH runner task failed: {error}"))??;

    let finished = Utc::now();
    let output_bytes = tokio::fs::read(&output_path).await.unwrap_or_default();
    let stdout = clean_powershell_stdout(&decode_high_output(&output_bytes));
    let exit_code = status.code().unwrap_or(-1);

    let _ = tokio::fs::remove_dir_all(&directory).await;

    Ok(ServerMessage::CommandResult {
        cycle_id,
        exit_code,
        stdout,
        stderr: String::new(),
        started_at: started.to_rfc3339(),
        finished_at: finished.to_rfc3339(),
        attachments: Vec::new(),
        attachment_errors: Vec::new(),
    })
}

fn clean_powershell_stdout(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut cleaned = Vec::new();

    for line in normalized.lines() {
        let trimmed = line.trim();

        if trimmed == "Windows PowerShell"
            || trimmed.starts_with("Copyright (C) Microsoft Corporation. All rights reserved.")
            || trimmed.starts_with("Install the latest PowerShell for new features and improvements!")
        {
            continue;
        }

        if trimmed.starts_with("PS ") {
            if let Some((_, remainder)) = line.split_once("> ") {
                if !remainder.trim().is_empty() {
                    cleaned.push(remainder.to_string());
                }
                continue;
            }
        }

        cleaned.push(line.to_string());
    }

    cleaned.join("\n").trim().to_string()
}

fn clean_powershell_stderr(raw: &str) -> String {
    const INTERNAL_EXIT_LINE: &str = "if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }";
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut cleaned = Vec::new();

    for line in normalized.lines() {
        let trimmed = line.trim();

        if trimmed == "PowerShell" {
            continue;
        }

        if line.contains(INTERNAL_EXIT_LINE) {
            if let Some((_, remainder)) = line.split_once(" : ") {
                if !remainder.trim().is_empty() {
                    cleaned.push(remainder.to_string());
                }
            }
            continue;
        }

        cleaned.push(line.to_string());
    }

    cleaned.join("\n").trim().to_string()
}

async fn run_powershell(command: &str, timeout_seconds: u64) -> Result<ServerMessage, String> {
    let cycle_id = Uuid::new_v4().to_string();
    let started = Utc::now();

    let script = format!(
        "{}\nif ($null -eq $LASTEXITCODE) {{ exit 0 }} else {{ exit $LASTEXITCODE }}",
        command
    );
    let child = spawn_powershell(&script)?;

    let output = timeout(
        Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("PowerShell timed out after {timeout_seconds}s"))?
    .map_err(|error| error.to_string())?;

    let finished = Utc::now();
    let exit_code = output.status.code().unwrap_or(-1);
    let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_raw = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(ServerMessage::CommandResult {
        cycle_id,
        exit_code,
        stdout: clean_powershell_stdout(&stdout_raw),
        stderr: clean_powershell_stderr(&stderr_raw),
        started_at: started.to_rfc3339(),
        finished_at: finished.to_rfc3339(),
        attachments: Vec::new(),
        attachment_errors: Vec::new(),
    })
}


fn parse_gp_attach(line: &str) -> Result<(u8, String), String> {
    let mut fields = line.trim().splitn(4, ' ');

    if fields.next() != Some("GP_ATTACH") {
        return Err("invalid GP_ATTACH prefix".into());
    }

    let channel_text = fields
        .next()
        .and_then(|value| value.strip_prefix("channel="))
        .ok_or("missing attachment channel")?;

    let channel: u8 = channel_text
        .parse()
        .map_err(|_| "invalid attachment channel")?;

    if !(1..=3).contains(&channel) {
        return Err("attachment channel must be 1, 2, or 3".into());
    }

    if fields.next() != Some("type=image") {
        return Err("only GP_ATTACH type=image is supported".into());
    }

    let remaining = fields
        .next()
        .and_then(|value| value.strip_prefix("path="))
        .ok_or("missing attachment path")?;

    let path = remaining
        .split_once(" caption=")
        .map(|(left, _)| left)
        .unwrap_or(remaining)
        .trim()
        .trim_matches('"')
        .to_string();

    if path.is_empty() {
        return Err("empty attachment path".into());
    }

    Ok((channel, path))
}

fn verified_image_mime(extension: &str, bytes: &[u8]) -> Option<&'static str> {
    match extension {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") =>
            Some("image/png"),
        "jpg" | "jpeg"
            if bytes.starts_with(&[0xff, 0xd8, 0xff]) =>
            Some("image/jpeg"),
        "webp"
            if bytes.len() >= 12
                && &bytes[0..4] == b"RIFF"
                && &bytes[8..12] == b"WEBP" =>
            Some("image/webp"),
        _ => None,
    }
}

async fn read_gp_attachments(
    stdout: &str,
    channel: u8,
) -> (Vec<ImageAttachment>, Vec<String>) {
    const MAX_IMAGES: usize = 3;
    const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
    const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;

    let mut images = Vec::new();
    let mut errors = Vec::new();
    let mut total_bytes = 0usize;

    let manifest_lines: Vec<&str> = stdout
        .lines()
        .filter(|line| line.trim().starts_with("GP_ATTACH "))
        .collect();

    if manifest_lines.is_empty() {
        return (images, errors);
    }

    let root = match tokio::fs::canonicalize(
        r"U:\UEdevROOT\Game1\Saved",
    ).await {
        Ok(root) => root,
        Err(error) => {
            errors.push(format!("Image root unavailable: {error}"));
            return (images, errors);
        }
    };

    for line in manifest_lines {
        if images.len() >= MAX_IMAGES {
            errors.push("Maximum three GP images per result".into());
            break;
        }

        let (requested_channel, filename) = match parse_gp_attach(line) {
            Ok(value) => value,
            Err(error) => {
                errors.push(error);
                continue;
            }
        };

        if requested_channel != channel {
            errors.push(format!(
                "Attachment channel {} does not match {}",
                requested_channel, channel
            ));
            continue;
        }

        let requested_path = PathBuf::from(filename);

        if !requested_path.is_absolute() {
            errors.push("GP image path must be absolute".into());
            continue;
        }

        let resolved = match tokio::fs::canonicalize(&requested_path).await {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("GP image path unavailable: {error}"));
                continue;
            }
        };

        if !resolved.starts_with(&root) {
            errors.push("GP image path is outside Game1 Saved".into());
            continue;
        }

        let metadata = match tokio::fs::metadata(&resolved).await {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("GP image metadata error: {error}"));
                continue;
            }
        };

        if !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_IMAGE_BYTES
        {
            errors.push("GP image is empty, too large, or not a file".into());
            continue;
        }

        if total_bytes + metadata.len() as usize > MAX_TOTAL_BYTES {
            errors.push("GP image total size limit exceeded".into());
            break;
        }

        let data = match tokio::fs::read(&resolved).await {
            Ok(bytes) => bytes,
            Err(error) => {
                errors.push(format!("GP image read failed: {error}"));
                continue;
            }
        };

        if data.is_empty() || data.len() as u64 > MAX_IMAGE_BYTES {
            errors.push("GP image size changed during read".into());
            continue;
        }

        let extension = resolved
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let mime = match verified_image_mime(&extension, &data) {
            Some(mime) => mime,
            None => {
                errors.push(
                    "GP image extension or file signature invalid".into()
                );
                continue;
            }
        };

        let name = resolved
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());

        total_bytes += data.len();

        images.push(ImageAttachment {
            name,
            mime_type: mime.into(),
            base64_data: STANDARD.encode(&data),
            bytes: data.len(),
            channel,
        });
    }

    (images, errors)
}

#[cfg(test)]
mod gp_attach_tests {
    use super::{parse_gp_attach, verified_image_mime};

    #[test]
    fn parser_preserves_spaces_in_windows_paths() {
        let parsed = parse_gp_attach(
            r"GP_ATTACH channel=2 type=image path=U:\Game1 Folder\image.png"
        ).unwrap();
        assert_eq!(parsed.0, 2);
        assert_eq!(parsed.1, r"U:\Game1 Folder\image.png");
    }

    #[test]
    fn invalid_channel_is_rejected() {
        assert!(parse_gp_attach(
            r"GP_ATTACH channel=4 type=image path=C:\x.png"
        ).is_err());
    }

    #[test]
    fn image_magic_must_match_extension() {
        let png = b"\x89PNG\r\n\x1a\nsample";
        assert_eq!(verified_image_mime("png", png), Some("image/png"));
        assert_eq!(verified_image_mime("jpg", png), None);
    }

    #[tokio::test]
    async fn real_game1_png_roundtrip_v1() {
        use base64::Engine as _;

        let path = r"U:\UEdevROOT\Game1\Saved\G1HeadwatersVisualStaging\headwaters_visual_comparison_v1.png";

        let original_bytes = tokio::fs::read(path)
            .await
            .expect("Real Game1 test PNG must exist");

        let manifest = format!(
            "BEFORE\nGP_ATTACH channel=1 type=image path={path}\nAFTER"
        );

        let (images, errors) =
            super::read_gp_attachments(&manifest, 1).await;

        assert!(errors.is_empty(), "Transport errors: {:?}", errors);
        assert_eq!(images.len(), 1);

        let image = &images[0];

        assert_eq!(image.channel, 1);
        assert_eq!(image.name, "headwaters_visual_comparison_v1.png");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.bytes, original_bytes.len());

        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&image.base64_data)
            .expect("Base64 transport must decode");

        assert_eq!(decoded, original_bytes);

        let (wrong_images, wrong_errors) =
            super::read_gp_attachments(&manifest, 2).await;

        assert!(wrong_images.is_empty());
        assert!(!wrong_errors.is_empty());

        println!("REAL_GAME1_PNG_READ=PASS");
        println!("PNG_BASE64_BYTE_ROUNDTRIP=PASS");
        println!("WRONG_CHANNEL_IMAGE=BLOCKED");
        println!("REAL_PNG_BYTES={}", original_bytes.len());
    }
}

async fn append_session_log(message: &ServerMessage) -> Result<(), String> {
    let line = serde_json::to_string(message).map_err(|error| error.to_string())? + "\n";
    let directory = PathBuf::from("sessions");
    tokio::fs::create_dir_all(&directory).await.map_err(|error| error.to_string())?;
    let file = directory.join(format!("{}.jsonl", Utc::now().format("%Y-%m-%d")));

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).append(true);
    let mut handle = options.open(file).await.map_err(|error| error.to_string())?;
    handle.write_all(line.as_bytes()).await.map_err(|error| error.to_string())
}

async fn send_json(
    sink: &mut SplitSink<WebSocketStream<TcpStream>, Message>,
    value: &ServerMessage,
) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    sink.send(Message::Text(text.into()))
        .await
        .map_err(|error| error.to_string())
}
