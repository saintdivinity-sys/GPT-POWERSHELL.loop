use crate::safety;
use chrono::Utc;
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
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

#[derive(Debug)]
pub struct BridgeState {
    pub mode: String,
    pub port: u16,
    pub server_started: bool,
    pub timeout_seconds: u64,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            mode: "stopped".into(),
            port: 47177,
            server_started: false,
            timeout_seconds: 300,
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
            if let Err(error) = handle_connection(state, stream).await {
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
                send_json(&mut sink, &ServerMessage::Error { message: error.to_string() }).await?;
                continue;
            }
        };

        match parsed {
            ClientMessage::Hello { page_url } => {
                if let Some(url) = page_url {
                    eprintln!("browser connected: {url}");
                }
            }
            ClientMessage::Ping => send_json(&mut sink, &ServerMessage::Pong).await?,
            ClientMessage::AssistantCommand { command, marker, assistant_text } => {
                let _assistant_text = assistant_text;

                if marker != "GPTPS_EXEC" {
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: "strict marker missing".into(),
                        level: "red".into(),
                    }).await?;
                    continue;
                }

                let mode = state.lock().await.mode.clone();
                if mode == "paused" || mode == "stopped" {
                    send_json(&mut sink, &ServerMessage::Paused {
                        reason: format!("bridge mode is {mode}"),
                    }).await?;
                    continue;
                }

                let decision = safety::classify(&command);
                if !decision.allowed {
                    send_json(&mut sink, &ServerMessage::Blocked {
                        reason: decision.reason,
                        level: decision.level.into(),
                    }).await?;
                    continue;
                }

                let timeout_seconds = state.lock().await.timeout_seconds;
                match run_powershell(&command, timeout_seconds).await {
                    Ok(result) => {
                        append_session_log(&result).await.ok();
                        send_json(&mut sink, &result).await?;

                        if mode == "step" {
                            state.lock().await.mode = "paused".into();
                        }
                    }
                    Err(message) => {
                        state.lock().await.mode = "paused".into();
                        send_json(&mut sink, &ServerMessage::Error { message }).await?;
                    }
                }
            }
        }
    }

    Ok(())
}

fn powershell_command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn spawn_powershell() -> Result<tokio::process::Child, String> {
    match powershell_command("pwsh.exe").spawn() {
        Ok(child) => Ok(child),
        Err(pwsh_error) => match powershell_command("powershell.exe").spawn() {
            Ok(child) => Ok(child),
            Err(windows_powershell_error) => Err(format!(
                "failed to start PowerShell. pwsh.exe: {pwsh_error}; powershell.exe: {windows_powershell_error}"
            )),
        },
    }
}

async fn run_powershell(command: &str, timeout_seconds: u64) -> Result<ServerMessage, String> {
    let cycle_id = Uuid::new_v4().to_string();
    let started = Utc::now();

    let mut child = spawn_powershell()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(command.as_bytes()).await.map_err(|error| error.to_string())?;
        stdin.write_all(b"\nexit $LASTEXITCODE\n").await.map_err(|error| error.to_string())?;
    }

    let output = timeout(
        Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("PowerShell timed out after {timeout_seconds}s"))?
    .map_err(|error| error.to_string())?;

    let finished = Utc::now();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(ServerMessage::CommandResult {
        cycle_id,
        exit_code,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
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
