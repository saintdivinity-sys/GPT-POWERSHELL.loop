use crate::safety;
use chrono::Utc;
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
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
                guard.push_console("stderr", format!("WebSocket connection error: {error}"));
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
                state.lock().await.push_console("stderr", format!("Protocol parse error: {error}"));
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
            ClientMessage::AssistantCommand { command, marker, assistant_text } => {
                let _assistant_text = assistant_text;
                state.lock().await.push_console("command", command.clone());

                if marker != "GPTPS_EXEC" {
                    state.lock().await.push_console("stderr", "Blocked: strict GPTPS_EXEC marker missing");
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
                    state.lock().await.push_console("stderr", format!("Blocked by safety gate: {}", decision.reason));
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: decision.reason,
                        level: decision.level.into(),
                    }).await?;
                    continue;
                }

                state.lock().await.push_console("status", format!("Running in mode: {mode}"));
                let timeout_seconds = state.lock().await.timeout_seconds;
                match run_powershell(&command, timeout_seconds).await {
                    Ok(result) => {
                        if let ServerMessage::CommandResult { cycle_id, exit_code, stdout, stderr, .. } = &result {
                            let mut guard = state.lock().await;
                            guard.push_console("meta", format!("cycle_id: {cycle_id} · exit_code: {exit_code}"));
                            if !stdout.trim().is_empty() {
                                guard.push_console("stdout", stdout.clone());
                            }
                            if !stderr.trim().is_empty() {
                                guard.push_console("stderr", stderr.clone());
                            }
                        }

                        append_session_log(&result).await.ok();
                        send_json(&mut sink, &result).await?;

                        if mode == "step" {
                            let mut guard = state.lock().await;
                            guard.mode = "paused".into();
                            guard.push_console("status", "STEP complete → PAUSED");
                        }
                    }
                    Err(message) => {
                        let mut guard = state.lock().await;
                        guard.mode = "paused".into();
                        guard.push_console("stderr", message.clone());
                        guard.push_console("status", "Execution error → PAUSED");
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

    Ok(ServerMessage::CommandResult {
        cycle_id,
        exit_code,
        stdout: clean_powershell_stdout(&stdout_raw),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
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
