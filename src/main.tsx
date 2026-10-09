/* GP_COMPACT_CARD_LAYOUT_V2 */
import { tr, type GpLocale, type GpTranslationKey } from "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { mountCosmosField } from "./cosmosField";
import "./styles.css";


function GPCosmosField() {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return mountCosmosField(canvas);
  }, []);

  return <canvas className="ccCanvasField" ref={canvasRef} aria-hidden="true" />;
}

type Mode = "step" | "auto_safe" | "paused" | "stopped";
type AlertSound = "error" | "attention" | "critical";

declare global {
  interface Window {
    __GPTPS_OVERLAY_KIND__?: AlertSound;
  }
}

type BridgeSnapshot = {
  mode: Mode;
  port: number;
  server_started: boolean;
  server_stopping: boolean;
  timeout_seconds: number;
  high_active: boolean;
  execution_active: boolean;
  execution_started_at_ms: number | null;
  has_last_accepted_command: boolean;
  last_accepted_command: string | null;
};

type ConsoleEntry = {
  id: number;
  at: string;
  kind: "command" | "stdout" | "stderr" | "status" | "meta" | "attention" | "critical" | string;
  text: string;
};


// GP_STORAGE_UI_V2
type StorageDrive = {
  path: string;
  label: string;
};
type StorageEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  bytes: number;
};
type StorageListing = {
  path: string;
  entries: StorageEntry[];
  truncated: boolean;
};
type StorageCandidate = {
  name: string;
  path: string;
  bytes: number;
  reason: string;
};
type StorageScan = {
  root: string;
  files_scanned: number;
  directories_scanned: number;
  scanned_bytes: number;
  candidate_count: number;
  candidate_bytes: number;
  candidates: StorageCandidate[];
  truncated: boolean;
  skipped_links: number;
  read_errors: number;
};

function OverlayApp({ kind }: { kind: AlertSound }) {
  const content = kind === "error" ? "?" : kind === "attention" ? "!" : "CRITICAL";
  const label = kind === "error" ? "PowerShell error" : kind === "attention" ? "Attention required" : "Critical bridge event";

  return (
    <main className={`alertOverlay ${kind}`} aria-label={label}>
      <div className="alertVisual">{content}</div>
    </main>
  );
}

function App() {
  // GP_I18N_STAGE1
  // GP_I18N_STAGE2
  // GP_I18N_STAGE3
  // GP_I18N_STAGE4A
  // GP_I18N_STAGE4B
  // GP_I18N_STAGE4C
  const [language, setLanguage] = React.useState<GpLocale>(() =>
    localStorage.getItem("gptps_language") === "ru" ? "ru" : "en"
  );
  const t = (key: GpTranslationKey) => tr(language, key);

  React.useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const [mode, setMode] = React.useState<Mode>("stopped");
  const [status, setStatus] = React.useState("Bridge offline");
  const [port, setPort] = React.useState(47177);
  const [focusChannel, setFocusChannel] =
    React.useState<1 | 2 | 3>(1);
  // GP_STOP_BRIDGE_UI_V1
  const [serverStarted, setServerStarted] = React.useState(false);
  const [serverStopping, setServerStopping] = React.useState(false);
  const [highActive, setHighActive] = React.useState(false);
  const [executionActive, setExecutionActive] = React.useState(false);
  const [executionStartedAtMs, setExecutionStartedAtMs] =
    React.useState<number | null>(null);
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const [soundEnabled, setSoundEnabled] = React.useState(() => localStorage.getItem("gptps_sound_enabled") !== "off");
  const [soundMenuOpen, setSoundMenuOpen] = React.useState(false);
  const [storageCleanerOpen, setStorageCleanerOpen] = React.useState(false);

  const [storageDrives, setStorageDrives] = React.useState<StorageDrive[]>([]);
  const [storagePath, setStoragePath] = React.useState("");
  const [storageListing, setStorageListing] = React.useState<StorageListing | null>(null);
  const [storageScan, setStorageScan] = React.useState<StorageScan | null>(null);
  const [storageBusy, setStorageBusy] = React.useState<GpTranslationKey | null>(null);
  const [storageError, setStorageError] = React.useState("");
  const consoleEndRef = React.useRef<HTMLDivElement | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const soundBaselineReadyRef = React.useRef(false);
  const lastSoundEntryIdRef = React.useRef(0);
  const soundOpenTimerRef = React.useRef<number | null>(null);
  const soundCloseTimerRef = React.useRef<number | null>(null);

  const ensureAudioReady = React.useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, []);

  const playAlertSound = React.useCallback(async (kind: AlertSound, force = false) => {
    if (!soundEnabled && !force) return;

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
      type: OscillatorType = "sine",
      endFrequency?: number
    ) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + offset;
      const end = start + duration;

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency && endFrequency > 0) {
        oscillator.frequency.exponentialRampToValueAtTime(endFrequency, end);
      }

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.025, duration * 0.15));
      gain.gain.setValueAtTime(volume, Math.max(start + 0.03, end - 0.08));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.03);
    };

    // ERROR: deliberately non-musical, game-show-style wrong-answer buzzer.
    // It is low, rough and descending so it cannot be confused with Attention/Critical.
    if (kind === "error") {
      tone(188.0, 0.00, 0.56, 0.22, "sawtooth", 116.0);
      tone(143.0, 0.01, 0.55, 0.14, "square", 91.0);
      tone(97.0, 0.02, 0.53, 0.08, "sawtooth", 72.0);
      return;
    }

    // ATTENTION: preserve the accepted rising three-note signal.
    if (kind === "attention") {
      tone(523.25, 0.00, 0.24, 0.14, "triangle");
      tone(659.25, 0.18, 0.28, 0.16, "triangle");
      tone(783.99, 0.40, 0.42, 0.18, "triangle");
      return;
    }

    // CRITICAL: preserve the accepted low-high-mid three-note pattern.
    tone(261.63, 0.00, 0.32, 0.20, "triangle");
    tone(523.25, 0.26, 0.34, 0.24, "triangle");
    tone(329.63, 0.54, 0.48, 0.24, "triangle");
  }, [ensureAudioReady, soundEnabled]);

  const showAlertOverlay = React.useCallback(async (kind: AlertSound) => {
    try {
      await invoke<number>("show_alert_overlay", { kind });
    } catch (error) {
      console.warn("[GPTPS] failed to show alert overlay", error);
    }
  }, []);

  const presentAlert = React.useCallback((kind: AlertSound, forceSound = false) => {
    if (soundEnabled || forceSound) {
      void playAlertSound(kind, forceSound);
    }
    void showAlertOverlay(kind);
  }, [playAlertSound, showAlertOverlay, soundEnabled]);

  const syncState = React.useCallback(async () => {
    try {
      const [snapshot, entries] = await Promise.all([
        invoke<BridgeSnapshot>("get_state"),
        invoke<ConsoleEntry[]>("get_console_log")
      ]);

      setMode(snapshot.mode);
      setServerStarted(snapshot.server_started);
      setServerStopping(snapshot.server_stopping);
      setHighActive(snapshot.high_active);
      setExecutionActive(snapshot.execution_active);
      setExecutionStartedAtMs(snapshot.execution_started_at_ms);
      setLastAcceptedCommand(snapshot.last_accepted_command);
      // Preserve channel selection until this instance starts listening.
      if (snapshot.server_started) {
        setPort(snapshot.port);
      }
      setConsoleEntries(entries);

      if (snapshot.server_started) {
        setStatus(snapshot.high_active
          ? `Listening on ws://127.0.0.1:${snapshot.port} · Execution: HIGH · Base mode: ${snapshot.mode}`
          : `Listening on ws://127.0.0.1:${snapshot.port} · Mode: ${snapshot.mode}`);
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
    if (fresh.length === 0) return;

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
      presentAlert(requested);
    }
  }, [consoleEntries, presentAlert]);

  React.useEffect(() => {
    return () => {
      if (soundOpenTimerRef.current !== null) window.clearTimeout(soundOpenTimerRef.current);
      if (soundCloseTimerRef.current !== null) window.clearTimeout(soundCloseTimerRef.current);
    };
  }, []);

  function beginSoundMenuHover() {
    if (soundCloseTimerRef.current !== null) {
      window.clearTimeout(soundCloseTimerRef.current);
      soundCloseTimerRef.current = null;
    }
    if (soundMenuOpen || soundOpenTimerRef.current !== null) return;

    soundOpenTimerRef.current = window.setTimeout(() => {
      setSoundMenuOpen(true);
      soundOpenTimerRef.current = null;
    }, 1000);
  }

  function endSoundMenuHover() {
    if (soundOpenTimerRef.current !== null) {
      window.clearTimeout(soundOpenTimerRef.current);
      soundOpenTimerRef.current = null;
    }

    soundCloseTimerRef.current = window.setTimeout(() => {
      setSoundMenuOpen(false);
      soundCloseTimerRef.current = null;
    }, 220);
  }

  async function testAlert(kind: AlertSound) {
    presentAlert(kind, true);
  }

  async function setBridgeMode(next: Mode) {
    try {
      if (soundEnabled) await ensureAudioReady();
      await invoke("set_mode", { mode: next });
      await syncState();
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function stopBridge() {
    if (!serverStarted || serverStopping || executionActive) {
      return;
    }

    try {
      await invoke<string>("stop_bridge");
      await syncState();
    } catch (error) {
      setStatus(String(error));
      await syncState();
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

  function requestManualReplay(asHigh: boolean) {
    if (
      replayBusyRef.current ||
      executionActive ||
      !serverStarted ||
      mode === "stopped" ||
      !lastAcceptedCommand
    ) {
      setCommandCopyNotice(t("replayUnavailable"));
      return;
    }

    setCommandCopyNotice("");

    setReplayRequest({
      kind: asHigh ? "HIGH" : "EXEC",
      command: lastAcceptedCommand
    });
  }

  async function confirmManualReplay() {
    if (!replayRequest || replayBusyRef.current) return;

    const request = replayRequest;
    setReplayRequest(null);

    replayBusyRef.current = true;
    setReplayBusy(true);
    setCommandCopyNotice(`Manual ${request.kind} replay requested...`);

    try {
      const result = await invoke<string>("replay_last_command", {
        asHigh: request.kind === "HIGH",
        expectedCommand: request.command,
        confirmed: true
      });

      setCommandCopyNotice(result);
    } catch (error) {
      setCommandCopyNotice(`Replay failed: ${String(error)}`);
    } finally {
      replayBusyRef.current = false;
      setReplayBusy(false);
      await syncState();
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


  function storageFormatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return "Unknown";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = -1;
    do {
      value /= 1024;
      index++;
    } while (value >= 1024 && index < units.length - 1);
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
  }

  function storageParent(path: string): string | null {
    const trimmed = path.replace(/[\\/]+$/, "");
    const slash = Math.max(
      trimmed.lastIndexOf("\\"),
      trimmed.lastIndexOf("/")
    );

    if (slash < 2) return null;
    if (slash === 2 && /^[A-Za-z]:/.test(trimmed)) {
      return trimmed.slice(0, 3);
    }

    return trimmed.slice(0, slash);
  }

  async function storageBrowse(path: string) {
    if (!path.trim()) {
      setStorageError("gp:enterFolderPath");
      return;
    }

    setStorageBusy("openingFolder");
    setStorageError("");
    setStorageScan(null);

    try {
      const listing = await invoke<StorageListing>(
        "storage_list_directory",
        { path: path.trim() }
      );
      setStorageListing(listing);
      setStoragePath(listing.path);
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setStorageBusy(null);
    }
  }

  async function storageOpen() {
    setStorageCleanerOpen(true);
    setStorageBusy("detectingDrives");
    setStorageError("");
    setStorageScan(null);

    try {
      const drives = await invoke<StorageDrive[]>("storage_drives");
      setStorageDrives(drives);

      const chosen = drives.find(
        (drive) => drive.path.toUpperCase().startsWith("C:")
      ) ?? drives[0];

      if (!chosen) {
        setStorageError("gp:noDrivesFound");
        return;
      }

      const listing = await invoke<StorageListing>(
        "storage_list_directory",
        { path: chosen.path }
      );

      setStoragePath(listing.path);
      setStorageListing(listing);
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setStorageBusy(null);
    }
  }

  async function storageRunScan() {
    if (!storagePath.trim()) {
      setStorageError("gp:selectFolderBeforeScan");
      return;
    }

    setStorageBusy("scanningFiles");
    setStorageError("");
    setStorageScan(null);

    try {
      const scan = await invoke<StorageScan>(
        "storage_scan_folder",
        { path: storagePath.trim() }
      );

      setStorageScan(scan);
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setStorageBusy(null);
    }
  }

  // CC_COSMOS_STORAGE_V1
  const displayMode = highActive ? "high" : mode;
  // ccCarouselDragV1
  const ring: Array<1 | 2 | 3> = [1, 2, 3];
  const focusIndex = ring.indexOf(focusChannel);
  const cardOrder: Array<1 | 2 | 3> = [
    ring[(focusIndex + 2) % 3],
    focusChannel,
    ring[(focusIndex + 1) % 3]
  ];

  type CarouselDrag = {
    pointerId: number;
    startX: number;
    startY: number;
    card: HTMLElement;
  };

  const dragRef = React.useRef<CarouselDrag | null>(null);
  const suppressClickUntilRef = React.useRef(0);
  const previousCardRects = React.useRef<Map<number, DOMRect>>(new Map());

  function focusCarouselChannel(channel: 1 | 2 | 3) {
    setFocusChannel(channel);
    if (!serverStarted) {
      setPort(47176 + channel);
    }
  }

  function beginCarouselDrag(
    event: React.PointerEvent<HTMLButtonElement>
  ) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const card = event.currentTarget.closest(".ccChannelCard");
    if (!(card instanceof HTMLElement)) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      card
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      dragRef.current = null;
    }
  }

  function moveCarouselDrag(
    event: React.PointerEvent<HTMLButtonElement>
  ) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) return;

    const offset = Math.max(-115, Math.min(115, dx));
    const scale = Math.max(.94, 1 - Math.abs(offset) * .00045);

    drag.card.classList.add("ccDragging");
    drag.card.style.setProperty("--cc-drag-x", `${offset}px`);
    drag.card.style.setProperty("--cc-drag-scale", String(scale));
  }

  function finishCarouselDrag(
    event: React.PointerEvent<HTMLButtonElement>,
    cancelled = false
  ) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;

    drag.card.classList.remove("ccDragging");
    drag.card.style.removeProperty("--cc-drag-x");
    drag.card.style.removeProperty("--cc-drag-scale");

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (
      cancelled ||
      Math.abs(dx) < 65 ||
      Math.abs(dx) < Math.abs(dy) * 1.1
    ) return;

    suppressClickUntilRef.current = Date.now() + 500;

    const index = ring.indexOf(focusChannel);
    const next = dx < 0
      ? ring[(index + 1) % 3]
      : ring[(index + 2) % 3];

    focusCarouselChannel(next);
  }

  React.useLayoutEffect(() => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".ccChannelCard[data-cc-card-channel]"
      )
    );

    const current = new Map<number, DOMRect>();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    for (const card of cards) {
      const id = Number(card.dataset.ccCardChannel);
      const rect = card.getBoundingClientRect();
      const previous = previousCardRects.current.get(id);

      if (previous && !reducedMotion) {
        const x = previous.left - rect.left;
        const y = previous.top - rect.top;

        if (Math.abs(x) > 3 || Math.abs(y) > 3) {
          card.getAnimations().forEach((animation) => animation.cancel());

          card.animate(
            [
              {
                transform:
                  `translate(${x}px, ${y}px) ` +
                  `scale(${previous.width / Math.max(rect.width, 1)})`
              },
              { transform: "translate(0px, 0px) scale(1)" }
            ],
            {
              duration: 430,
              easing: "cubic-bezier(.22, .78, .20, 1)"
            }
          );
        }
      }

      current.set(id, rect);
    }

    previousCardRects.current = current;
  }, [focusChannel]);
  const boundChannel = port - 47176;
  const lastCommandEntry = [...consoleEntries].reverse().find(
    (entry) => entry.kind === "command"
  );
  // GP_LIVE_EXECUTION_STATUS_V1
  // Use authoritative Rust state, never infer a running process from log order.
  const execRunning = executionActive && !highActive;
  const activeExecution = executionActive;
  const elapsedSeconds =
    activeExecution && executionStartedAtMs !== null
      ? Math.max(0, Math.floor((Date.now() - executionStartedAtMs) / 1000))
      : 0;
  const elapsedLabel = [
    Math.floor(elapsedSeconds / 3600),
    Math.floor((elapsedSeconds % 3600) / 60),
    elapsedSeconds % 60
  ].map((part) => String(part).padStart(2, "0")).join(":");
  const logBytes = new Blob([
    consoleEntries.map((entry) => entry.text).join("\\n")
  ]).size;
  const logSize = logBytes < 1024
    ? `${logBytes} B`
    : logBytes < 1048576
      ? `${(logBytes / 1024).toFixed(1)} KB`
      : `${(logBytes / 1048576).toFixed(2)} MB`;
  const latestCommand = lastCommandEntry?.text ?? t("noCommands");
  const latestOutput = consoleEntries
    .filter((entry) =>
      Boolean(lastCommandEntry) &&
      entry.id > (lastCommandEntry?.id ?? 0) &&
      (entry.kind === "stdout" || entry.kind === "stderr")
    )
    .map((entry) => `${entry.kind.toUpperCase()}\n${entry.text}`)
    .join("\n\n");

  const [commandDialogOpen, setCommandDialogOpen] = React.useState(false);
  // GP_MANUAL_REPLAY_UI_V1
  const [lastAcceptedCommand, setLastAcceptedCommand] =
    React.useState<string | null>(null);

  const [replayRequest, setReplayRequest] =
    React.useState<{ kind: "EXEC" | "HIGH"; command: string } | null>(null);

  const [replayBusy, setReplayBusy] = React.useState(false);
  const replayBusyRef = React.useRef(false);
  const [commandCopyNotice, setCommandCopyNotice] = React.useState("");

  async function copyCommandText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCommandCopyNotice(`${label} copied to clipboard`);
    } catch (error) {
      setCommandCopyNotice(`Clipboard unavailable: ${String(error)}`);
    }
  }

  return (
    <main className="app ccAppRoot">
      <GPCosmosField />
      <header>
        <div>
          <p className="eyebrow">{t("localBridge")}</p>
          <h1>GPT-POWERSHELL.loop</h1>
        </div>
        <div className="headerControls">
          <div
            className="soundControlWrap"
            onMouseEnter={beginSoundMenuHover}
            onMouseLeave={endSoundMenuHover}
          >
            <button
              className={`soundToggle ${soundEnabled ? "on" : "off"}`}
              onClick={toggleSound}
              aria-pressed={soundEnabled}
              title={t("soundHint")}
            >
              {soundEnabled ? t("soundOn") : t("soundOff")}
            </button>

            {soundMenuOpen && (
              <div className="soundTestMenu" role="menu" aria-label={t("testSoundsAria")}>
                <div className="soundTestTitle">{t("testAlerts")}</div>
                <button className="soundTestButton error" onClick={() => void testAlert("error")}>{t("soundError")}</button>
                <button className="soundTestButton attention" onClick={() => void testAlert("attention")}>{t("soundAttention")}</button>
                <button className="soundTestButton critical" onClick={() => void testAlert("critical")}>{t("soundCritical")}</button>
                <div className="soundTestHint">{t("soundOverlay")}</div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="storageCleanerTrigger"
            onClick={() => void storageOpen()}
            title={t("storageCleaner")}
          >
            <span className="storageCleanerTriggerIcon" aria-hidden="true">&#9881;</span>
            <span>{t("storageCleaner")}</span>
          </button>
          <span className={`pill ${displayMode}`}>
            {highActive ? "HIGH" :
              mode === "step" ? t("modeStep") :
              mode === "auto_safe" ? t("modeAuto") :
              mode === "paused" ? t("modePaused") : t("modeStopped")}
          </span>
          <button
            type="button"
            className="gpLanguageToggle"
            onClick={() => {
              const next = language === "en" ? "ru" : "en";
              localStorage.setItem("gptps_language", next);
              setLanguage(next);
            }}
            aria-label={language === "en" ? "Switch to Russian" : "Переключить на английский"}
            title={language === "en" ? "Switch to Russian" : "Переключить на английский"}
          >
            <span
              className={`gpLanguageFlag ${language === "ru" ? "gpFlagRu" : "gpFlagUs"}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>


      <div className="ccControlCenter">
        <aside className="ccRail">
          <div className="ccRailHeading">{t("channels")}</div>
          {([1, 2, 3] as const).map((channel) => {
            const isBound = channel === boundChannel;
            const focused = channel === focusChannel;
            return (
              <button
                key={channel}
                className={`ccRailChannel ${focused ? "selected" : ""}`}
                onClick={() => {
                  setFocusChannel(channel);
                  if (!serverStarted) setPort(47176 + channel);
                }}
                aria-pressed={focused}
                title={`View Channel ${channel}`}
              >
                <span className="ccRailNumber">{channel}</span>
                <span className="ccRailText">
                  <strong>{t("channel")} {channel}</strong>
                  <small>{isBound && serverStarted ? t("connected") : t("disconnected")}</small>
                </span>
                <span className={`ccRailDot ${isBound && serverStarted ? "online" : ""}`} />
              </button>
            );
          })}
          <div className="ccRailBottom">
            <span className={`ccRailDot ${serverStarted ? "online" : ""}`} />
            <span>{serverStarted ? t("bridgeOnline") : t("bridgeOffline")}</span>
          </div>
        </aside>

        <section className="ccWorkspace">
          <div className="ccTopline">
            <div>
              <div className="ccEyebrow">{t("executionControl")}</div>
              <h2>{t("workspaceTitle")}</h2>
              <p>{t("workspaceDescription")}</p>
            </div>
            <span className="ccPortLabel">
              {serverStarted ? "Connected" : "Offline"} · :{port}
            </span>
          </div>

          <div className="ccCardRow">
            {cardOrder.map((channel) => {
              const focused = focusChannel === channel;
              const bound = boundChannel === channel;
              const online = serverStarted && bound;
              const running = online && activeExecution;
              const high = online && highActive;
              const channelMode = online
                ? high ? "HIGH" : mode.toUpperCase().replace("_", " ")
                : "OFFLINE";

              return (
                <article
                  key={channel}
                  data-cc-card-channel={channel}
                  className={`ccChannelCard ${focused ? "ccFocused" : "ccCompact"} ${running ? "ccExecuting" : ""} ${high ? "ccHighRunning" : ""}`}
                >
                  <div className={`ccNeonStrip ${!online ? "ccStripOffline" : high ? "ccStripHigh" : running ? "ccStripExecuting" : mode === "paused" || mode === "stopped" ? "ccStripPaused" : "ccStripReady"}`} />
                  <button
                    type="button"
                    className="ccCardTitle"
                    onPointerDown={beginCarouselDrag}
                    onPointerMove={moveCarouselDrag}
                    onPointerUp={(event) => finishCarouselDrag(event)}
                    onPointerCancel={(event) => finishCarouselDrag(event, true)}
                    onClick={(event) => {
                      if (Date.now() < suppressClickUntilRef.current) {
                        event.preventDefault();
                      }
                    }}
                    onDoubleClick={() => focusCarouselChannel(channel)}
                    title={t("carouselHint")}
                    aria-label={`Drag or double-click to focus Channel ${channel}`}
                  >
                    <span>{t("channel")} {channel}</span>
                    <span className="ccChevron">{focused ? "●" : "›"}</span>
                  </button>
                  {focused && bound && (
  <button
    type="button"
    className="ccExpandCommandButton"
    onClick={() => {
      setCommandCopyNotice("");
      setCommandDialogOpen(true);
    }}
  >{t("expandCommand")}</button>
)}
<div className="ccCardStatus">
                    <span className={`ccStatusOrb ${online ? "online" : ""}`} />
                    <span>{online ? t("connected") : t("disconnected")}</span>
                    <span className={`ccModeTag ${high ? "high" : ""}`}>
                      {channelMode}
                    </span>
                  </div>
                  <div
                    className="ccCommandPreview"
                    role={bound ? "button" : undefined}
                    tabIndex={bound ? 0 : undefined}
                    title={bound ? t("previewHint") : undefined}
                    onDoubleClick={() => {
                      if (bound) {
                        setCommandCopyNotice("");
                        setCommandDialogOpen(true);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (bound && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setCommandCopyNotice("");
                        setCommandDialogOpen(true);
                      }
                    }}
                  >
                    <div className="ccCommandPreviewHeader">
  <small>{running ? t("currentCommand") : t("lastCommand")}</small>
  {focused && bound && (
    <button
      type="button"
      className="ccCommandCopyIcon"
      disabled={!latestOutput.trim()}
      title={t("copyOutput")}
      aria-label={t("copyOutput")}
      onClick={(event) => {
        event.stopPropagation();
        void copyCommandText(latestOutput, t("copyOutput"));
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </svg>
    </button>
  )}
</div>
                    <code>{bound ? latestCommand : t("independentChannel")}</code>
                  </div>

                  {focused ? (
                    <>
                      {bound ? (
                        <>
                          <div className="ccBridgeToggleRow">
  <button
    type="button"
    className={`ccBridgeToggleButton ${serverStarted ? "bridgeStop" : "bridgeStart"}`}
    disabled={serverStopping || (serverStarted && executionActive)}
    onClick={() => void (serverStarted ? stopBridge() : startBridge())}
  >
    {serverStarted
      ? (serverStopping ? t("bridgeStopping") : t("stopBridge"))
      : t("startBridge")}
  </button>
</div>
<div className="ccExecutionStatus">
                            <span className={running ? "ccPulseDot" : "ccQuietDot"} />
                            {high ? `${t("highRunning")} · ${elapsedLabel}` :
                              execRunning ? `${t("execRunning")} · ${elapsedLabel}` :
                              mode === "paused" ? t("pausedNoCommand") :
                              mode === "stopped" ? t("stoppedNoCommand") :
                              `${t("waiting")} · ${
                                mode === "step" ? t("modeStep") :
                                mode === "auto_safe" ? t("modeAuto") :
                                t("modeStopped")
                              }`}
                          </div>
<div className="ccModeControls gpCompactModes">
  <button
    className="gpModeGo"
    disabled={!serverStarted || serverStopping}
    onClick={() => void setBridgeMode("step")}
  >{t("step")}</button>
  <button
    className="gpModeGo"
    disabled={!serverStarted || serverStopping}
    onClick={() => void setBridgeMode("auto_safe")}
  >{t("auto")}</button>
  <button
    className="gpModePause"
    disabled={!serverStarted || serverStopping}
    onClick={() => void setBridgeMode("paused")}
  >{t("pause")}</button>
</div>
<div className="ccReplayToolRow">
                            <button
                              type="button"
                              disabled={
                                !serverStarted ||
                                !lastAcceptedCommand ||
                                executionActive ||
                                replayBusy ||
                                mode === "stopped"
                              }
                              onClick={() => requestManualReplay(false)}
                              title={t("replayExecHint")}
                            >
                              {t("repeatExec")}
                            </button>
                            <button
                              type="button"
                              className="ccReplayHigh"
                              disabled={
                                !serverStarted ||
                                !lastAcceptedCommand ||
                                executionActive ||
                                replayBusy ||
                                mode === "stopped"
                              }
                              onClick={() => requestManualReplay(true)}
                              title={t("replayHighHint")}
                            >
                              {t("repeatHigh")}
                            </button>
                          </div>
{commandCopyNotice && (
                            <div className="ccCopyNotice">{commandCopyNotice}</div>
                          )}
<button
  type="button"
  className="ccStopButton ccStopExecutionFull"
  disabled
  title={t("cancellationHint")}
>{t("stopExecution")}</button>
<div className="ccStorageTiles">
                            <div title={t("bufferHint")}>
                              <span>{t("liveBuffer")}</span>
                              <strong>{logSize}</strong>
                            </div>
                            <div title={t("archiveHint")}>
                              <span>{t("photoArchive")}</span>
                              <strong>{t("notConfigured")}</strong>
                            </div>
                          </div>
                          <details className="ccMiniGroup">
                            <summary>{t("storageFolders")}</summary>
                            <p>{t("storageInfo")}</p>
                            <p>{t("gameImagesSafety")}</p>
                          </details>
                          <details className="ccMiniGroup">
                            <summary>{t("protocolConnection")}</summary>
                            <p>{t("listeningPort")}: {port}</p>
                            <pre>{`GPTPS_EXEC:${channel}
\`\`\`powershell
Write-Output test
\`\`\`

GPTPS_HIGH:${channel}
\`\`\`powershell
Write-Output test
\`\`\``}</pre>
                          </details>
                        </>
                      ) : (
                        <div className="ccNotBound">
                          {t("notBoundDescription")}
                          {serverStarted
                            ? ` ${t("currentBound")} ${t("channel")} ${boundChannel}.`
                            : ` ${t("connectPrompt")}`}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="ccCompactFooter">
                      <span>{online && running ? t("uiExecuting") : online ? t("uiReady") : t("uiOffline")}</span>
                      <span>{t("viewLabel")} &gt;</span>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <div className="ccPanels">
            <details className="ccLogPanel" open>
              <summary>
                <span>{t("executionLogTitle")}</span>
                <span className="ccCount">{consoleEntries.length} {t("eventsLabel")}</span>
              </summary>
              <div className="ccPanelBody">
                <div className="ccLogToolbar">
                  <span>{t("channel")} {boundChannel} — {logSize} {t("liveBufferLabel")}</span>
                  <button onClick={clearConsole}>{t("clearScreenLabel")}</button>
                </div>
                <div className="ccLogOutput">
                  {consoleEntries.length === 0 ? (
                    <div className="ccEmpty">{t("noActivity")}</div>
                  ) : (
                    consoleEntries.map((entry) => (
                      <div key={entry.id} className={`ccLogEntry ${entry.kind}`}>
                        <time>{new Date(entry.at).toLocaleTimeString()}</time>
                        <span>{entry.kind.toUpperCase()}</span>
                        <code>{entry.text}</code>
                      </div>
                    ))
                  )}
                  <div ref={consoleEndRef} />
                </div>
              </div>
            </details>

            <details className="ccActivityPanel">
              <summary>{t("sessionPreferences")}</summary>
              <div className="ccPanelBody">
                <p><strong>{t("bridgeLabel")}:</strong> {status}</p>
                <p><strong>{t("modeLabel")}:</strong> {displayMode.toUpperCase()}</p>
                <p><strong>{t("highActiveLabel")}:</strong> {highActive ? t("yes") : t("no")}</p>
                <p><strong>{t("imagesLabel")}:</strong> {t("imagesPending")}</p>
                <p><strong>{t("cancelExecutionLabel")}:</strong> {t("cancelPending")}</p>
              </div>
            </details>
          </div>
        </section>
      </div>

      {replayRequest && (
        <div
          className="gpCommandBackdrop"
          onClick={() => setReplayRequest(null)}
        >
          <section
            className="gpCommandDialog gpReplayDialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("replaySubtitle")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="gpCommandDialogHeader">
              <div>
                <h3>{t("replayAs")} {replayRequest.kind}?</h3>
                <p>{t("channel")} {boundChannel} — {t("replaySubtitle")}</p>
              </div>
            </div>

            <div className="gpReplayWarning">
              {t("replayWarning")}
            </div>

            <div className="gpCommandDialogToolbar">
              <strong>{t("commandToExecute")}</strong>
              <button
                type="button"
                onClick={() =>
                  void copyCommandText(replayRequest.command, "Command")
                }
              >
                {t("copyCommand")}
              </button>
            </div>

            <pre tabIndex={0}>{replayRequest.command}</pre>

            <div className="gpReplayActions">
              <button
                type="button"
                onClick={() => setReplayRequest(null)}
                autoFocus
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className={replayRequest.kind === "HIGH" ? "ccReplayHigh" : ""}
                onClick={() => void confirmManualReplay()}
              >
                {t("confirm")} {replayRequest.kind}
              </button>
            </div>

            {commandCopyNotice && (
              <div className="gpCommandDialogNotice">
                {commandCopyNotice}
              </div>
            )}
          </section>
        </div>
      )}
      {commandDialogOpen && (
        <div
          className="gpCommandBackdrop"
          onClick={() => setCommandDialogOpen(false)}
        >
          <section
            className="gpCommandDialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("commandViewer")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="gpCommandDialogHeader">
              <div>
                <h3>{t("channel")} {boundChannel} — {t("commandViewer")}</h3>
                <p>{t("commandViewerSubtitle")}</p>
              </div>
              <button
                type="button"
                onClick={() => setCommandDialogOpen(false)}
                autoFocus
              >
                {t("close")}
              </button>
            </div>

            <div className="gpCommandDialogToolbar">
              <strong>{t("lastCommand")}</strong>
              <button
                type="button"
                onClick={() => void copyCommandText(latestCommand, "Command")}
              >
                {t("copyCommand")}
              </button>
            </div>

            <textarea
              readOnly
              spellCheck={false}
              value={latestCommand}
              aria-label={t("lastCommand")}
            />

            <div className="gpCommandDialogToolbar">
              <strong>{t("commandOutput")}</strong>
              <button
                type="button"
                disabled={!latestOutput.trim()}
                onClick={() => void copyCommandText(latestOutput, "Output")}
              >
                Copy output
              </button>
            </div>

            <pre tabIndex={0}>
              {latestOutput || t("noOutput")}
            </pre>

            <div className="gpCommandDialogNotice">
              {commandCopyNotice || t("manualCopyHint")}
            </div>
          </section>
        </div>
      )}

      {storageCleanerOpen && (
        <div
          className="storageCleanerOverlay"
          role="presentation"
          onClick={() => setStorageCleanerOpen(false)}
        >
          <div
            className="storageCleanerModal"
            role="dialog"
            aria-modal="true"
            aria-label={t("storageCleaner")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="storageCleanerHeader">
              <div>
                <div className="storageCleanerEyebrow">{t("storageReadOnly")}</div>
                <h3>{t("storageCleaner")}</h3>
                <p>
                  {t("storageDescription")}
                </p>
              </div>
              <button
                type="button"
                className="storageCleanerClose"
                onClick={() => setStorageCleanerOpen(false)}
                aria-label={t("closeStorageCleaner")}
                title={t("close")}
              >
                X
              </button>
            </div>

            {storageError && (
              <div className="storageCleanerError" role="alert">
                {storageError.startsWith("gp:")
  ? t(storageError.slice(3) as GpTranslationKey)
  : storageError}
              </div>
            )}

            {storageBusy && (
              <div className="storageCleanerBusy" role="status">
                {t(storageBusy)}
              </div>
            )}

            <div className="storageCleanerGrid">
              <section className="storageCleanerCard">
                <div className="storageCleanerCardTitle">{t("windowsDrives")}</div>

                <div className="storageCleanerPills">
                  {storageDrives.length === 0 ? (
                    <span className="storageCleanerHint">{t("noDrives")}</span>
                  ) : storageDrives.map((drive) => (
                    <button
                      key={drive.path}
                      type="button"
                      className={
                        "storageCleanerPill " +
                        (storagePath.toUpperCase().startsWith(
                          drive.path.toUpperCase()
                        ) ? "selected" : "")
                      }
                      disabled={Boolean(storageBusy)}
                      onClick={() => void storageBrowse(drive.path)}
                      title={drive.label}
                    >
                      {drive.path}
                    </button>
                  ))}
                </div>

                <label className="storageCleanerPathLabel">
                  {t("folderPath")}
                  <input
                    className="storageCleanerPathInput"
                    value={storagePath}
                    spellCheck={false}
                    placeholder={"C:\\Users\\..."}
                    onChange={(event) => setStoragePath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void storageBrowse(storagePath);
                      }
                    }}
                  />
                </label>

                <button
                  type="button"
                  className="storageCleanerGhost storageCleanerFullButton"
                  disabled={Boolean(storageBusy)}
                  onClick={() => void storageBrowse(storagePath)}
                >
                  {t("openFolder")}
                </button>

                <div className="storageCleanerHint">
                  {t("folderHint")}
                  {t("browsingReadOnly")}
                </div>
              </section>

              <section className="storageCleanerCard">
                <div className="storageCleanerCardTitle">{t("folderBrowser")}</div>

                {storageListing ? (
                  <>
                    <div className="storageCleanerCurrentPath" title={storageListing.path}>
                      {storageListing.path}
                    </div>

                    <button
                      type="button"
                      className="storageCleanerGhost storageCleanerFullButton"
                      disabled={
                        Boolean(storageBusy) ||
                        !storageParent(storageListing.path)
                      }
                      onClick={() => {
                        const parent = storageParent(storageListing.path);
                        if (parent) void storageBrowse(parent);
                      }}
                    >
                      {t("upOneFolder")}
                    </button>

                    <div className="storageCleanerDirectoryList">
                      {storageListing.entries.length === 0 ? (
                        <div className="storageCleanerHint">
                          {t("noFolderEntries")}
                        </div>
                      ) : storageListing.entries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          className="storageCleanerDirectoryEntry"
                          disabled={
                            Boolean(storageBusy) || !entry.is_directory
                          }
                          title={entry.path}
                          onClick={() => void storageBrowse(entry.path)}
                        >
                          <span className="storageCleanerEntryName">
                            <span>{entry.is_directory ? "[DIR]" : "[FILE]"}</span>
                            {entry.name}
                          </span>
                          <small>
                            {entry.is_directory
                              ? "Open"
                              : storageFormatBytes(entry.bytes)}
                          </small>
                        </button>
                      ))}
                    </div>

                    {storageListing.truncated && (
                      <div className="storageCleanerHint">
                        {t("listingTruncated")}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="storageCleanerHint">
                    {t("selectDriveFirst")}
                  </div>
                )}
              </section>

              <section className="storageCleanerCard">
                <div className="storageCleanerCardTitle">{t("scanReview")}</div>

                <button
                  type="button"
                  className="storageCleanerPrimary storageCleanerFullButton"
                  disabled={Boolean(storageBusy) || !storagePath.trim()}
                  onClick={() => void storageRunScan()}
                >
                  {t("scanFolder")}
                </button>

                {storageScan ? (
                  <>
                    <div className="storageCleanerPreviewStats">
                      <div>
                        <span>{t("filesScanned")}</span>
                        <strong>{storageScan.files_scanned.toLocaleString()}</strong>
                      </div>
                      <div>
                        <span>{t("scannedVolume")}</span>
                        <strong>{storageFormatBytes(storageScan.scanned_bytes)}</strong>
                      </div>
                      <div>
                        <span>{t("possibleCandidates")}</span>
                        <strong>{storageScan.candidate_count.toLocaleString()}</strong>
                      </div>
                      <div>
                        <span>{t("candidateSize")}</span>
                        <strong>{storageFormatBytes(storageScan.candidate_bytes)}</strong>
                      </div>
                    </div>

                    {storageScan.truncated && (
                      <div className="storageCleanerWarning">
                        {t("partialScan")}
                      </div>
                    )}

                    {storageScan.read_errors > 0 && (
                      <div className="storageCleanerHint">
                        {storageScan.read_errors} {t("readErrorsTail")}
                      </div>
                    )}

                    <div className="storageCleanerCandidateList">
                      {storageScan.candidates.length === 0 ? (
                        <div className="storageCleanerHint">
                          {t("noCandidates")}
                        </div>
                      ) : storageScan.candidates.map((item) => (
                        <div key={item.path} className="storageCleanerCandidate">
                          <strong title={item.path}>{item.name}</strong>
                          <span>{storageFormatBytes(item.bytes)}</span>
                          <small>{item.reason}</small>
                          <small title={item.path}>{item.path}</small>
                        </div>
                      ))}
                    </div>

                    {storageScan.candidate_count > storageScan.candidates.length && (
                      <div className="storageCleanerHint">
                        {t("showingFirst")} {storageScan.candidates.length} {t("candidatesTail")}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="storageCleanerHint">
                    {t("scanHint")}
                  </div>
                )}

                <button
                  type="button"
                  className="storageCleanerDanger storageCleanerFullButton"
                  disabled
                  title={t("deleteReadOnlyTooltip")}
                >
                  {t("deleteUnavailable")}
                </button>
              </section>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}

const overlayKind = window.__GPTPS_OVERLAY_KIND__;
if (overlayKind) {
  document.documentElement.classList.add("overlay-mode");
  document.body.classList.add("overlay-mode-body");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {overlayKind ? <OverlayApp kind={overlayKind} /> : <App />}
  </React.StrictMode>
);
