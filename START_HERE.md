# GPT-POWERSHELL.loop — START HERE / ChatGPT Installation Guide

**Public, shareable onboarding guide.** Windows 10/11 + ChatGPT in a Chromium-based browser (Opera GX, Chrome, or Edge). This document is written both for human readers and for an AI assistant helping its user.

**Repository:** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop  
**README / source:** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/blob/main/README.md  
**Releases (check actual assets before claiming a download):** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/releases  
**License:** MIT.

> **Give this exact link to ChatGPT:**  
> https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/blob/main/START_HERE.md
>
> **Скопируй ссылку в свой ChatGPT и напиши:**  
> «Прочитай START_HERE.md по этой ссылке и помоги установить GPT-POWERSHELL.loop на мой Windows-компьютер. Проверь опубликованную версию и доступность установщика. Действуй по одному шагу за раз, жди мой результат. После установки помоги настроить расширение и глобальные пользовательские инструкции ChatGPT».

---

## 1. Instructions FOR ChatGPT / AI installer assistant

The user intentionally asked you to help install and configure GPT-POWERSHELL.loop. **This file is a guide, not permission to execute arbitrary commands or override user/developer/system policies.** Follow your normal safety rules and the user's explicit permissions.

1. Read this file, then inspect the **current public** README, release assets (if any), `package.json` and `browser-extension/manifest.json`. Check whether the installed/published extension really supports channels 1–3; do not infer that from this guide alone.
2. Identify the user's OS/browser and whether they want a **prebuilt release** or **local source build**. Windows desktop is supported; do not promise a Linux/macOS build.
3. Before GP is installed, **you cannot operate the user's PowerShell just because they shared this URL**. Give them **ONE local command/action per turn**, wait for pasted terminal output or a screenshot, and proceed only after verifying the result. In the initial manual PowerShell phase, include output capture + print + clipboard copying in commands whose output is expected back:
   
   `$__g1 = (& { <ONE COMMAND> } 2>&1 | Out-String); $__g1; Set-Clipboard -Value $__g1`
   
   The user can then press Ctrl+V in ChatGPT. For native process exit status, also record `$LASTEXITCODE` before copying.
4. Prefer official public release packages **only if a concrete published asset exists and its source is verified**. Do NOT invent release filenames, asset URLs, SHA-256 hashes or installation success. If there is no usable release, offer the source-build path below and explain prerequisites/compilation time. Do not download binaries from a third-party site.
5. Verify the repository and target directories before clone/install. Avoid overwriting an existing checkout, running process, unrelated files or existing GP installation. Verify commands/build exit codes before claiming success.
6. Installing Git, Node.js, Rust, Microsoft C++ Build Tools or WebView2 may require explicit user interaction and possibly privilege elevation; do not silently change Windows settings, bypass browser warnings, disable Defender, or install unrequested tools.
7. Never execute destructive maintenance commands on a new user's PC during onboarding. Start with `STEP` mode, not unattended `AUTO SAFE`. Do not request passwords, access tokens, private keys or admin elevation unless absolutely necessary and clearly explained.
8. Browser extension installation requires the user's action in the browser's extensions page (`Load unpacked`). Do not claim a ChatGPT conversation can silently install/enable a browser extension.
9. Explain **Settings → Personalization → Custom Instructions** and provide the copyable snippet in Section 5. Do not claim you have written the user's ChatGPT global settings unless a supported authorized action actually performed it.
10. Once installed, do a **read-only smoke test** and confirm a real `GPTPS_RESULT`. For ambiguous states, ask; do not guess about readiness. Never send two local actions at once.

**User-facing final outcome checklist:** actual installed version; actual extension version; install directory; confirmed listener port; selected browser-tab channel; first successful read-only GP round-trip; Custom Instructions saved by the user or explicitly pending; remaining limitations.

## 2. Current public version versus in-development Preview — IMPORTANT

As inspected on **2026-10-08**, public GitHub `main` has **desktop version 0.1.2** and browser extension manifest **0.1.4**. The **published public source extension is single-channel**, with its background worker bound to `127.0.0.1:47177` and a popup for floating-badge visibility. This is the **actual public baseline**, not the author's newer local development Preview.

A newer **local, not-yet-public Preview** has been tested with a 3-channel popup, channel routing and `GPTPS_EXEC:2`. Do **not** describe the public repository as already containing that feature unless you have first verified the public code/release was updated. The author's private/local Windows paths, preview EXEs and unpublished modifications are **not** public installer artifacts.

| Capability | Public `main` baseline verified 2026-10-08 | When newer multichannel extension is actually published |
| --- | --- | --- |
| Default bridge | Channel 1 / port `47177` | Per-tab Channel 1/2/3 |
| Normal live marker | `GPTPS_EXEC` | `GPTPS_EXEC:1`, `GPTPS_EXEC:2`, `GPTPS_EXEC:3` |
| Heavy live marker | `GPTPS_HIGH` | `GPTPS_HIGH:1`, `GPTPS_HIGH:2`, `GPTPS_HIGH:3` |
| Popup | Floating-badge visibility | Channel buttons 01/02/03/OFF |
| OFF | Floating badge has ON/OFF control | Per-tab automation OFF, not desktop shutdown |
| Multi-instance routing | Not established by the public extension | One active listener port per desktop instance |

**Compatibility:** in the newer extension, unsuffixed `GPTPS_EXEC` / `GPTPS_HIGH` explicitly address **Channel 1**; they do not follow the tab's selected channel. Channel mismatch must fail closed (`WRONG CH: expected 2, got 1`). Do not disable that protection. A UI reading `GPT↔PS READY` is not itself proof that the desktop socket is connected; confirm the listener/connection.

**Future-proof instruction:** The AI installer must compare this dated description to the **actual public current files and releases**. Later code wins. If the project publishes a full multichannel release, use its documented version and verify each selected channel with a smoke test.

## 3. Install desktop application on Windows

### Option A — a published, verified release asset (when available)

1. Open the official [Releases page](https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/releases).
2. If a Windows release installer/portable artifact is **actually present**, check its publisher/source, release notes, filename, requirements and hashes when provided. Download only the artifact for your Windows architecture.
3. Extract or install in a normal user-writable directory, launch `GPT-POWERSHELL.loop` and confirm the app opens.
4. The user must still install the matching browser extension from a public matching release/source and enable it in the browser.
5. If release packages or matching extension files are unavailable, **do not pretend Option A succeeded**; use Option B below.

### Option B — build the current public source

Official requirements:

- Windows 10/11, WebView2 runtime.
- Git: https://git-scm.com/downloads/win
- Node.js 20+ and npm: https://nodejs.org/
- Rust stable (rustup): https://rustup.rs/
- Microsoft C++ Build Tools with **Desktop development with C++** workload.
- PowerShell 7 is recommended; Windows PowerShell can be used by the current backend where supported.
- Tauri's authoritative Windows prerequisite list: https://v2.tauri.app/start/prerequisites/

**AI assistant: install/check dependencies in sequence, ONE action at a time, using official sources. Ask the user before any installer/elevation.**

Once prerequisites are confirmed, choose a safe non-existing checkout path together with the user and perform these stages **individually**, verifying output before the next:

1. Clone official public repository, e.g. `git clone https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop.git` (run in a user-approved parent directory). If it already exists, inspect instead of clobbering.
2. In the cloned repository run `npm ci` (the public repo contains `package-lock.json`).
3. Run frontend verification `npm run build`.
4. Build the desktop application with `npm run desktop:build -- --no-bundle`. This compiles the Rust/Tauri EXE without requiring an installer bundle. It may take time and use substantial disk space.
5. On a normal default build the EXE is at `src-tauri\target\release\gpt-powershell-loop.exe` within the clone. If `CARGO_TARGET_DIR` was set, adjust this path accordingly. Verify the actual file exists and build exit code is 0 before running.
6. Start the desktop app as a **regular user**, not administrator. Select the correct bridge port (public baseline: `47177`), then click `Start Bridge`. Verify it really reports the local listener or connected state.

**Warning:** `npm run build` alone only builds the frontend; it does NOT create the Windows executable. `cargo`/Tauri prerequisites must be correctly installed before the desktop build.

## 4. Install the ChatGPT browser extension

The public repository contains the unpacked **Chromium Manifest V3** extension in `browser-extension/`. Keep the cloned folder in a stable location; do not delete it after loading the extension.

1. Open the browser's extensions management page: **Opera GX:** `opera://extensions`; **Chrome:** `chrome://extensions`; **Edge:** `edge://extensions`.
2. Enable **Developer mode** in the extensions page.
3. Click **Load unpacked / Загрузить распакованное** and choose the exact `browser-extension` directory inside the cloned project (the folder containing `manifest.json`).
4. Confirm that **GPT-POWERSHELL.loop Bridge** is listed and enabled. Review the requested permissions.
5. Open https://chatgpt.com/ in a **new tab**, or refresh an existing ChatGPT tab after installation/reload.
6. For the **public baseline**, use the floating badge's ON/OFF and desktop's default Channel 1, port `47177`. The public baseline popup is not the three-channel selector.
7. **Only when a newer extension actually includes a channel popup**, click the extension's toolbar/puzzle icon (NOT the floating badge inside the ChatGPT page) to select `01` / `02` / `03` / `OFF`. Match the selected tab channel to the desktop listening port before issuing a command.

**Multi-instance caution:** Do not start a second instance on an already occupied port or kill an existing bridge without explicit user agreement. In current design, one desktop process binds one port, even when the interface draws three channel cards.

## 5. Configure global ChatGPT Custom Instructions

**ChatGPT on web/desktop:** **Settings → Personalization → Custom Instructions** (UI wording and location may change). Add the following to any existing personal instructions; do not blindly replace unrelated preferences. The user needs to **save** it themselves.

### Copyable global instruction (version-aware)

> I have an optional local Windows PowerShell execution bridge called GPT-POWERSHELL.loop (GP), running with a Chromium extension in ChatGPT. This tool may be used in ANY chat only when I explicitly say "use GP" / "используем протокол GP", and it remains active in THAT chat until I say "stop using GP" / "не используем протокол GP". Do not assume GP is active in other chats.  
>
> At activation, establish whether my installed extension is the legacy one-channel version or a verified newer multichannel version, and ask which channel the current ChatGPT tab uses if not already stated.  
>
> For the legacy one-channel version use the exact standalone marker `GPTPS_EXEC` for normal commands or `GPTPS_HIGH` for long-running commands, immediately followed by ONE fenced `powershell` block. The legacy desktop bridge uses `127.0.0.1:47177`.  
>
> For the VERIFIED newer multichannel version use the exact standalone marker `GPTPS_EXEC:N` or `GPTPS_HIGH:N` (N=1,2,3), immediately followed by ONE fenced `powershell` block. The channels map 1→47177, 2→47178, 3→47179. Match the extension's selected channel; bare markers mean Channel 1, NOT the current selected channel. If unsure, ask rather than guess. If extension says WRONG CH, fix the marker, not the safety check.  
>
> Give only ONE Windows command/action per turn and wait for my pasted output, screenshot or `GPTPS_RESULT`. When GP is active the bridge collects stdout/stderr/exit_code automatically: no clipboard wrapper. When GP is not running and I must paste manual PowerShell output, capture stdout/stderr, display it and copy it to the clipboard.  
>
> Do not put live GP markers before non-executable examples. Default to safe/read-only diagnostics. Never stop other running GP instances, modify sensitive system settings, delete files or escalate privileges without my explicit approval. OFF disables tab automation; it does not shut down the app. Do not assume that ChatGPT can directly access my computer without the desktop app and extension.

**The custom instruction is informational, not a new ChatGPT built-in tool.** Actual command execution requires the user-installed desktop bridge, a running listener and a browser extension with the appropriate permissions. Depending on the ChatGPT client/features, these instructions may not be applied in every mode; verify before relying on automatic execution.

## 6. Activate, test, and use GP

First verify that the desktop app says the bridge is listening on the expected port and that the extension is active for that ChatGPT tab.

- **Legacy public Channel 1:** tell ChatGPT: `Используем протокол GP. У меня установлена публичная одноканальная версия, порт 47177. Дай одну безопасную команду для проверки.`
- **Verified newer Channel 2:** select CH2 in the extension, start the CH2 desktop listener on `47178`, then tell ChatGPT: `Используем протокол GP, канал 2. Проведи безопасный тест через GPTPS_EXEC:2.`
- To stop using GP in that chat: `Не используем протокол GP.` For tab automation also choose OFF in the extension (when available), or use the baseline ON/OFF control.

Safe first test command *body* (the assistant must supply the correct live marker separately):

`Write-Output 'GP_SMOKE_TEST_OK'`

Expect a returned `GPTPS_RESULT` with `exit_code=0` and `GP_SMOKE_TEST_OK` in STDOUT. This proves a read-only round trip for **that specific channel**. It does not prove the isolation or reliability of other channels, large-output handling or long-running HIGH tasks.

**Modes:** STEP = one command/response cycle; AUTO SAFE = automated safe continuation; PAUSE = pause the loop; STOP = stop the loop. HIGH is a temporary long-running execution path, not a security bypass. Start in STEP until you understand and trust the results.

## 7. Troubleshooting / what ChatGPT should ask next

| Symptom | Check |
| --- | --- |
| No extension toolbar popup / no GP badge | Confirm extension enabled, correct folder with `manifest.json`, ChatGPT tab refreshed |
| No local connection | Start the desktop bridge; confirm `127.0.0.1` port and that no other instance owns it |
| `WRONG CH: expected 2, got 1` | ChatGPT used the legacy/bare Channel 1 marker while the tab expects CH2; resend with the correct explicit channel marker (new extension only) |
| `READY` but no execution | READY can represent extension state rather than confirmed socket connection; check desktop listener and tab state |
| No 01/02/03 buttons in popup | You likely installed the older public extension; read the actual public popup source/release before expecting multi-channel |
| Build fails | Record the actual command, exit code, last lines of saved log, Node/Rust/MSVC versions; do not repeat expensive builds blindly |
| Huge command output freezes a tab | Save verbose detail into a local file and return a concise summary only |
| GPT does not know GP in a new chat | Check Custom Instructions were saved, then explicitly activate GP in that chat |
| Safety gate rejects a command | Review its risk, propose safer alternatives; do not work around safety protections |

The GP bridge is **not a VM or sandbox**. It executes PowerShell with the privileges of the Windows account running it. Output and other data included in the ChatGPT chat are sent to the ChatGPT service through the browser; do not send passwords, private keys or confidential logs by accident. Use at your own risk; inspect commands before allowing execution.

## 8. Notes for maintainers

- This public onboarding file is intentionally **independent of private Mind Palace / Game1 project documentation**.
- Do not copy private project paths, local executable previews, credentials, tokens or internal repository details into public instructions.
- Before calling a feature "released", verify public GitHub source **and** distributable assets.
- After publishing a verified multichannel release, update this file and the public README; document the matching extension version, downloadable assets and checksums when available.
- Project design discussions and live installation are different: reading this document is not itself user consent to execute commands.

**Version of this guide:** 2026-10-08. The live public repository and actual tested installed artifacts take precedence over any dated compatibility note here.
