import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Mode = "step" | "auto_safe" | "paused" | "stopped";

function App() {
  const [mode, setMode] = React.useState<Mode>("stopped");
  const [status, setStatus] = React.useState("Bridge offline");
  const [port, setPort] = React.useState(47177);

  async function setBridgeMode(next: Mode) {
    try {
      await invoke("set_mode", { mode: next });
      setMode(next);
      setStatus(next === "stopped" ? "Stopped" : `Mode: ${next}`);
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function startBridge() {
    try {
      const result = await invoke<string>("start_bridge", { port });
      setStatus(result);
      if (mode === "stopped") setMode("step");
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
              onChange={(event) => setPort(Number(event.target.value) || 47177)}
            />
          </label>
          <button onClick={startBridge}>Start local bridge</button>
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

      <section className="protocol">
        <h2>Expected assistant format</h2>
        <pre>{`GPTPS_EXEC\n\`\`\`powershell\nGet-ChildItem\n\`\`\``}</pre>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
