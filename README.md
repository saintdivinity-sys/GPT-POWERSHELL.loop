# GPT-POWERSHELL.loop

A Windows-first local bridge that can take an **explicit PowerShell command from a ChatGPT reply**, execute it locally, capture `stdout` + `stderr`, and send the result back into the ChatGPT tab — repeatedly until paused or stopped.

> **Status:** public early MVP / v0.1 scaffold  
> **Default safety:** strict execution marker + STEP mode + fail-closed guardrails.

## Intended workflow

On a small second monitor:

```text
┌──────────────────────┬────────────────────────┐
│ ChatGPT              │ PowerShell / Terminal  │
│                      │                        │
│ assistant reply      │ live command output    │
│ GPTPS_EXEC            │                        │
└──────────────────────┴────────────────────────┘
              GPT-POWERSHELL.loop
      [ STEP ] [ AUTO SAFE ] [ PAUSE ] [ STOP ]
```

The normal loop does **not** require stealing the user's mouse or keyboard.

## Architecture

```text
ChatGPT tab
  ↕ Chromium extension
ws://127.0.0.1:47177
  ↕
GPT-POWERSHELL.loop desktop app
  ├─ loop controller
  ├─ safety gate
  ├─ session log
  └─ PowerShell runner
        ↓
stdout + stderr
        ↓
browser extension
        ↓
ChatGPT composer
```

## Execution protocol

By default, the app executes only an explicitly marked assistant block:

````markdown
GPTPS_EXEC
```powershell
Get-ChildItem
```
````

Unmarked examples and code blocks are ignored.

The bridge then:

1. checks the safety policy;
2. runs PowerShell locally;
3. captures stdout and stderr;
4. sends a structured result back to the extension;
5. the extension inserts that result into ChatGPT;
6. **STEP** pauses after one round-trip;
7. **AUTO SAFE** waits for the next marked command and continues.

## Safety model

Modes:

- **STEP** — one command/result round-trip, then pause.
- **AUTO SAFE** — automatically continue only for commands accepted by the safety gate.
- **PAUSE** — keep the bridge connected but execute nothing.
- **STOP** — stop the loop.

The safety layer blocks high-risk patterns including destructive disk, boot, registry, shutdown and recursive-deletion operations. It is deliberately fail-closed.

**Important:** the classifier is a heuristic safety layer, **not a sandbox**. Do not run this tool elevated unless you actually need elevation.

## Current v0.1 scope

- Tauri 2 + React + TypeScript desktop shell
- Rust local WebSocket bridge
- PowerShell `stdout` / `stderr` capture
- strict `GPTPS_EXEC` marker
- STEP / AUTO SAFE / PAUSE / STOP
- basic command risk classification
- command timeout
- JSONL session logs
- Chromium Manifest V3 extension
- best-effort ChatGPT DOM observer
- best-effort result insertion into the composer
- no global mouse/keyboard automation

## Planned

- Win32 window picker by HWND
- transparent framing overlay around selected ChatGPT + terminal windows
- command approval cards
- process-tree cancellation
- persistent shell session option
- signed Windows releases
- configurable allow/block rules
- more browser adapters / shells

## Development

Requirements:

- Windows 10/11
- Node.js 20+
- Rust stable
- WebView2
- Tauri prerequisites
- PowerShell 7 (`pwsh.exe`) recommended

Run:

```powershell
npm install
npm run tauri dev
```

Load `browser-extension/` as an unpacked extension in Chromium.

## Privacy

The bridge is local-first. The local shell output is passed to the ChatGPT tab through the browser extension; no custom cloud relay is required.

## License

MIT.
