use crate::safety;
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
    sync::Mutex,
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
    },
    Error { message: String },
}

pub async fn serve(state: SharedState, port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| error.to_string())?;

    loop {
        let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(state.clone(), stream).await {
                let mut guard = state.lock().await;
                guard.push_console("critical", format!("WebSocket connection error: {error}"));
                eprintln!("connection error: {error}");
            }
        });
    }
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
                    guard.push_console("command", command.clone());
                }

                let is_high = marker == "GPTPS_HIGH";
                if marker != "GPTPS_EXEC" && !is_high {
                    state.lock().await.push_console("critical", "Blocked: strict GPTPS_EXEC/GPTPS_HIGH marker missing");
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: "strict marker missing".into(),
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

                if is_high {
                    let mut guard = state.lock().await;
                    guard.high_active = true;
                    guard.push_console("status", format!("HIGH started · base mode: {mode}"));
                } else {
                    state.lock().await.push_console("status", format!("Running in mode: {mode}"));
                }

                let timeout_seconds = state.lock().await.timeout_seconds;
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

                        append_session_log(&result).await.ok();
                        send_json(&mut sink, &result).await?;
                    }
                    Err(message) => {
                        let mut guard = state.lock().await;
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
    })
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
