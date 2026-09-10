import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Mode = "step" | "auto_safe" | "paused" | "stopped";
type AlertSound = "error" | "attention" | "critical";

type BridgeSnapshot = {
  mode: Mode;
  port: number;
  server_started: boolean;
  timeout_seconds: number;
};

type ConsoleEntry = {
  id: number;
  at: string;
  kind: "command" | "stdout" | "stderr" | "status" | "meta" | "attention" | "critical" | string;
  text: string;
};

function App() {
  const [mode, setMode] = React.useState<Mode>("stopped");
  const [status, setStatus] = React.useState("Bridge offline");
  const [port, setPort] = React.useState(47177);
  const [serverStarted, setServerStarted] = React.useState(false);
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const [soundEnabled, setSoundEnabled] = React.useState(() => localStorage.getItem("gptps_sound_enabled") !== "off");
  const consoleEndRef = React.useRef<HTMLDivElement | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const soundBaselineReadyRef = React.useRef(false);
  const lastSoundEntryIdRef = React.useRef(0);

  const ensureAudioReady = React.useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, []);

  const playAlertSound = React.useCallback(async (kind: AlertSound) => {
    if (!soundEnabled) return;

    let context: AudioContext;
    try {
      context = await ensureAudioReady();
    } catch {
      return;
    }

    const now = context.currentTime + 0.02;

    const tone = (
      frequency: number,
      offset: number,
      duration: number,
      volume: number,
      type: OscillatorType = "sine"
    ) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + offset;
      const end = start + duration;

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.03, duration * 0.2));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.03);
    };

    // Deliberately louder than normal UI feedback so alerts remain noticeable
    // while music, video, a game, or another application is playing.
    if (kind === "error") {
      tone(659.25, 0.00, 0.28, 0.18, "triangle");
      tone(493.88, 0.24, 0.42, 0.22, "triangle");
      return;
    }

    if (kind === "attention") {
      tone(523.25, 0.00, 0.24, 0.14, "triangle");
      tone(659.25, 0.18, 0.28, 0.16, "triangle");
      tone(783.99, 0.40, 0.42, 0.18, "triangle");
      return;
    }

    tone(261.63, 0.00, 0.32, 0.20, "triangle");
    tone(523.25, 0.26, 0.34, 0.24, "triangle");
    tone(329.63, 0.54, 0.48, 0.24, "triangle");
  }, [ensureAudioReady, soundEnabled]);

  const syncState = React.useCallback(async () => {
    try {
      const [snapshot, entries] = await Promise.all([
        invoke<BridgeSnapshot>("get_state"),
        invoke<ConsoleEntry[]>("get_console_log")
      ]);

      setMode(snapshot.mode);
      setServerStarted(snapshot.server_started);
      setPort(snapshot.port);
      setConsoleEntries(entries);

      if (snapshot.server_started) {
        setStatus(`Listening on ws://127.0.0.1:${snapshot.port} · Mode: ${snapshot.mode}`);
      } else {
        setStatus(snapshot.mode === "stopped" ? "Bridge offline" : `Mode: ${snapshot.mode}`);
      }
    } catch (error) {
      setStatus(String(error));
    }
  }, []);

  React.useEffect(() => {
    syncState();
    const timer = window.setInterval(syncState, 500);
    return () => window.clearInterval(timer);
  }, [syncState]);

  React.useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ block: "end" });
  }, [consoleEntries]);

  React.useEffect(() => {
    const maxId = consoleEntries.reduce((max, entry) => Math.max(max, entry.id), 0);

    if (!soundBaselineReadyRef.current) {
      lastSoundEntryIdRef.current = maxId;
      soundBaselineReadyRef.current = true;
      return;
    }

    const fresh = consoleEntries.filter((entry) => entry.id > lastSoundEntryIdRef.current);
    lastSoundEntryIdRef.current = maxId;
    if (!soundEnabled || fresh.length === 0) return;

    let requested: AlertSound | null = null;

    for (const entry of fresh) {
      if (entry.kind === "critical") {
        requested = "critical";
        break;
      }

      if (entry.kind === "attention") {
        requested = "attention";
        continue;
      }

      const exitMatch = entry.kind === "meta" ? entry.text.match(/exit_code:\s*(-?\d+)/i) : null;
      const nonZeroExit = exitMatch ? Number(exitMatch[1]) !== 0 : false;
      if (!requested && (entry.kind === "stderr" || nonZeroExit)) {
        requested = "error";
      }
    }

    if (requested) {
      void playAlertSound(requested);
    }
  }, [consoleEntries, playAlertSound, soundEnabled]);

  async function setBridgeMode(next: Mode) {
    try {
      if (soundEnabled) await ensureAudioReady();
      await invoke("set_mode", { mode: next });
      await syncState();
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function startBridge() {
    try {
      if (soundEnabled) await ensureAudioReady();
      await invoke<string>("start_bridge", { port });
      await syncState();
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function clearConsole() {
    try {
      await invoke("clear_console_log");
      await syncState();
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem("gptps_sound_enabled", next ? "on" : "off");
    if (next) {
      try {
        await ensureAudioReady();
      } catch {
        // The next user interaction can unlock audio if WebView2 suspended it.
      }
    }
  }

  return (
    <main className="app">
      <header>
        <div>
          <p className="eyebrow">LOCAL WINDOWS BRIDGE</p>
          <h1>GPT-POWERSHELL.loop</h1>
        </div>
        <div className="headerControls">
          <button
            className={`soundToggle ${soundEnabled ? "on" : "off"}`}
            onClick={toggleSound}
            aria-pressed={soundEnabled}
            title="Sound alerts: PowerShell error, ChatGPT attention, critical bridge event"
          >
            {soundEnabled ? "🔊 SOUND ON" : "🔇 SOUND OFF"}
          </button>
          <span className={`pill ${mode}`}>{mode.toUpperCase()}</span>
        </div>
      </header>

      <section className="hero">
        <div className="statusDot" />
        <div>
          <strong>{status}</strong>
          <p>ChatGPT ↔ PowerShell round-trip controller</p>
        </div>
      </section>

      <section className="grid">
        <article>
          <h2>Connection</h2>
          <label>
            Local WebSocket port
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={serverStarted}
              onChange={(event) => setPort(Number(event.target.value) || 47177)}
            />
          </label>
          <button onClick={startBridge} disabled={serverStarted}>
            {serverStarted ? "Bridge running" : "Start local bridge"}
          </button>
        </article>

        <article>
          <h2>Loop mode</h2>
          <div className="actions">
            <button onClick={() => setBridgeMode("step")}>STEP</button>
            <button onClick={() => setBridgeMode("auto_safe")}>AUTO SAFE</button>
            <button onClick={() => setBridgeMode("paused")}>PAUSE</button>
            <button className="danger" onClick={() => setBridgeMode("stopped")}>STOP</button>
          </div>
          <p className="hint">
            v0.1 always requires the strict GPTPS_EXEC marker. Unmarked assistant code is ignored.
          </p>
          <p className="soundLegend">Sound alerts: error · attention required · critical bridge/safety event</p>
        </article>
      </section>

      <details className="collapsible protocolBlock">
        <summary>
          <span>Expected assistant format</span>
          <span className="summaryHint">show / hide</span>
        </summary>
        <div className="collapsibleBody">
          <pre>{`GPTPS_EXEC\n\`\`\`powershell\nGet-ChildItem\n\`\`\``}</pre>
        </div>
      </details>

      <details className="collapsible consolePanel" open>
        <summary>
          <span>PowerShell monitor</span>
          <span className="summaryHint">{consoleEntries.length} entries · show / hide</span>
        </summary>
        <div className="collapsibleBody">
          <div className="consoleToolbar">
            <div>
              <strong>Actual bridge execution output</strong>
              <p>Read-only monitor of the same PowerShell execution path used by GPTPS_EXEC.</p>
            </div>
            <button onClick={clearConsole}>Clear</button>
          </div>

          <div className="consoleOutput" aria-live="polite">
            {consoleEntries.length === 0 ? (
              <div className="consoleEmpty">PowerShell activity will appear here.</div>
            ) : (
              consoleEntries.map((entry) => (
                <div className={`consoleEntry ${entry.kind}`} key={entry.id}>
                  <div className="consoleEntryHeader">
                    <span>{new Date(entry.at).toLocaleTimeString()}</span>
                    <span>{entry.kind.toUpperCase()}</span>
                  </div>
                  <div className="consoleEntryText">
                    {entry.kind === "command" ? `PS> ${entry.text}` : entry.text}
                  </div>
                </div>
              ))
            )}
            <div ref={consoleEndRef} />
          </div>
        </div>
      </details>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
