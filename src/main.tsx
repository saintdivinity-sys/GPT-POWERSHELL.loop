import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Mode = "step" | "auto_safe" | "paused" | "stopped";

type BridgeSnapshot = {
  mode: Mode;
  port: number;
  server_started: boolean;
  timeout_seconds: number;
};

type ConsoleEntry = {
  id: number;
  at: string;
  kind: "command" | "stdout" | "stderr" | "status" | "meta" | string;
  text: string;
};

function App() {
  const [mode, setMode] = React.useState<Mode>("stopped");
  const [status, setStatus] = React.useState("Bridge offline");
  const [port, setPort] = React.useState(47177);
  const [serverStarted, setServerStarted] = React.useState(false);
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const consoleEndRef = React.useRef<HTMLDivElement | null>(null);

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

  async function setBridgeMode(next: Mode) {
    try {
      await invoke("set_mode", { mode: next });
      await syncState();
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function startBridge() {
    try {
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

  return (
    <main className="app">
      <header>
        <div>
          <p className="eyebrow">LOCAL WINDOWS BRIDGE</p>
          <h1>GPT-POWERSHELL.loop</h1>
        </div>
        <span className={`pill ${mode}`}>{mode.toUpperCase()}</span>
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
