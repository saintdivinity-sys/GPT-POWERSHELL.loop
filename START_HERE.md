
# GPT-POWERSHELL.loop — Установка из исходников / Install from source

**Windows 10/11 · Chromium (Opera GX, Chrome или Edge) · два пути: Codex или ChatGPT.**

**Официальный репозиторий:** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop  
**Эта инструкция:** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/blob/main/START_HERE.md  
**Исходники / README:** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/blob/main/README.md  
**Releases:** https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/releases (скачивание готовой программы возможно только при наличии реально опубликованного файла).  
**Лицензия:** MIT.

## Выберите способ установки / Choose your assistant

Оба способа **собирают GP из исходного кода GitHub на Windows**, затем устанавливают расширение браузера и проверяют соединение. Это не два разных дистрибутива. **До установки GP ChatGPT сам по себе не может выполнять PowerShell на вашем ПК.**

### Вариант 1 — Через Codex / Install with Codex

Для человека, у которого **Codex уже настроен для работы с локальными файлами и терминалом Windows**. Если Codex запущен в облаке или не имеет доступа к этому ПК, он не сможет установить программу на Windows автоматически: попросите его объяснить, как подключить локальное рабочее окружение, или выберите вариант 2.

1. Откройте Codex и выберите доступную ему локальную рабочую папку на Windows (не существующую папку GP).
2. Скопируйте текст ниже в Codex. Codex должен **сначала прочитать этот документ и актуальные файлы репозитория**, затем вести установку пошагово с проверкой результатов и запросом разрешений.

> Прочитай https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/blob/main/START_HERE.md и актуальный репозиторий. Я выбираю **установку через Codex из исходников** на Windows. Сначала проверь, есть ли у тебя реальный доступ к моему локальному Windows-терминалу и рабочей папке. Не утверждай, что установка выполнена, пока не проверены файлы и результаты команд. Проверь официальные требования (Git, Node.js/npm, Rust, MSVC Build Tools, WebView2), запроси разрешение на необходимые установки, предложи безопасную папку клонирования, затем по одному проверяемому действию выполни clone, npm ci, frontend build, Tauri desktop build, подключение расширения браузера и первый read-only тест GP. Не перезаписывай существующие данные, не используй force push, не отключай защиту Windows и не запускай ничего с правами администратора без моего явного согласия. Настройка расширения и ChatGPT Custom Instructions — с моим участием.

### Вариант 2 — Через ChatGPT / Install guided by ChatGPT

Для человека, который пользуется обычным ChatGPT в браузере. ChatGPT объясняет **одно действие за раз**. Человек выполняет команды в PowerShell и вставляет полученный вывод. После установки GP становится возможен автоматизированный обмен через Bridge.

1. Откройте новый чат ChatGPT: https://chatgpt.com/
2. Отправьте ссылку на эту инструкцию и скопируйте следующий текст:

> Прочитай https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop/blob/main/START_HERE.md и актуальный GitHub-репозиторий. Я выбираю **установку через ChatGPT из исходников** на Windows. Пока GP не установлен, ты не можешь самостоятельно запускать PowerShell на моём ПК. Веди меня строго по одному действию/команде за раз, жди мой результат или скриншот. Команды, вывод которых я должен прислать, должны захватывать stdout+stderr, отображать вывод и автоматически копировать его в буфер обмена; при вызове программ также проверяй их exit code. Сначала проверь зависимости из официальных источников; затем помоги безопасно клонировать проект, выполнить npm ci, npm run build и npm run desktop:build -- --no-bundle. Проверь реально созданный EXE, помоги загрузить расширение browser-extension в Opera GX/Chrome/Edge, выбрать нужный канал и проверить безопасный GPTPS_RESULT. В конце объясни глобальные Custom Instructions. Не удаляй данные и не меняй настройки безопасности без моего согласия.

**For English-speaking users:** Give your Codex or ChatGPT assistant the link above and say: “Read START_HERE.md, help me build and install this Windows app from public source, using the Codex path / ChatGPT path. Perform one verified action at a time, request permission for installs, and guide extension setup plus first smoke test.”

**Перед началом:** сборка Tauri требует Node.js, Rust и C++ Build Tools и может занять значительное время и место на диске. Запуск скачанного кода выполняется с правами текущего пользователя; предварительно ознакомьтесь с исходниками и рисками. Для этого проекта на момент проверки **нет опубликованных GitHub Releases с готовым установщиком**; ссылки на частные Preview EXE не являются публичными установочными файлами.

---

## 1. Instructions for Codex and ChatGPT assistants

The user intentionally asked you to help build, install and configure GPT-POWERSHELL.loop from the public repository. **This file is a guide, not permission to execute arbitrary commands or override user/developer/system policies.** Follow your normal safety rules and the user's explicit permissions.

1. Read this file, then inspect the **current public** README, release assets (if any), `package.json`, `src-tauri/tauri.conf.json`, `browser-extension/manifest.json`, and extension popup/background code. Verify channels, ports and actual build scripts from source.
2. Identify the user's Windows version/browser and whether they chose **Codex with a real local Windows execution environment** or **manual PowerShell with ChatGPT**. Both paths here use a local source build; do not promise a Linux/macOS build.
3. **ChatGPT without a connected local execution tool cannot run PowerShell merely because this URL was shared.** With ChatGPT, give the person **ONE local action/command per turn**, wait for pasted output/screenshot, then verify. Codex may run commands only when its actual execution environment can access the user's Windows PC and permissions allow; Codex must also verify each step and request approval when needed. During manual PowerShell steps, capture stdout/stderr, display and copy all requested output to the clipboard:
   
   `$__g1 = (& { <ONE COMMAND> } 2>&1 | Out-String); $__g1; Set-Clipboard -Value $__g1`
   
   The user can then press Ctrl+V in ChatGPT. For native process exit status, also record `$LASTEXITCODE` before copying.
4. This document is the **source-build** guide. Do NOT invent prebuilt releases, asset URLs, SHA-256 hashes or successful installs; explain prerequisites and build time. If someone explicitly asks for a binary, only use a real verified GitHub release. Do not download binaries from third-party sites.
5. Verify the repository and target directories before clone/install. Avoid overwriting an existing checkout, running process, unrelated files or existing GP installation. Verify commands/build exit codes before claiming success.
6. Installing Git, Node.js, Rust, Microsoft C++ Build Tools or WebView2 may require explicit user interaction and possibly privilege elevation; do not silently change Windows settings, bypass browser warnings, disable Defender, or install unrequested tools.
7. Never execute destructive maintenance commands on a new user's PC during onboarding. Start with `STEP` mode, not unattended `AUTO SAFE`. Do not request passwords, access tokens, private keys or admin elevation unless absolutely necessary and clearly explained.
8. Browser extension installation requires the user's action in the browser's extensions page (`Load unpacked`). Do not claim a ChatGPT conversation can silently install/enable a browser extension.
9. Explain **Settings → Personalization → Custom Instructions** and provide the copyable snippet in Section 5. Do not claim you have written the user's ChatGPT global settings unless a supported authorized action actually performed it.
10. Once installed, do a **read-only smoke test** and confirm a real `GPTPS_RESULT`. For ambiguous states, ask; do not guess about readiness. Never send two local actions at once.

**User-facing final outcome checklist:** actual installed version; actual extension version; install directory; confirmed listener port; selected browser-tab channel; first successful read-only GP round-trip; Custom Instructions saved by the user or explicitly pending; remaining limitations.


## 2. Public source status and channels — verified after commit 37de51f

The public GitHub `main` branch was updated on **2026-10-08** to commit `37de51fb2339ebfda96da27fde0d455d6d8862a5`. Source `package.json` and Tauri config still report desktop version `0.1.2`; `browser-extension/manifest.json` reports `0.1.4`. **These version strings alone do not prove which features are present** — inspect the actual source.

At that commit, the **public source extension supports per-tab channel selection 01 / 02 / 03 / OFF**. Its background script and Rust Bridge use:

| Channel | Local WebSocket | Normal marker | Long-running marker |
| --- | --- | --- | --- |
| 1 | `127.0.0.1:47177` | `GPTPS_EXEC:1` or legacy `GPTPS_EXEC` | `GPTPS_HIGH:1` or legacy `GPTPS_HIGH` |
| 2 | `127.0.0.1:47178` | `GPTPS_EXEC:2` | `GPTPS_HIGH:2` |
| 3 | `127.0.0.1:47179` | `GPTPS_EXEC:3` | `GPTPS_HIGH:3` |

**Important:** unsuffixed markers always mean Channel 1, not whichever tab is selected. Mismatched channel commands must be rejected. For each active channel, start a matching desktop Bridge listener. The Control Center can visually show three channel cards, but a single desktop process listens on the selected port, **not all three simultaneously**. Confirm the listener; a UI showing READY is not enough.

The public source now includes the multichannel interface, updated extension, Storage Cleaner and neon UI. **No public GitHub Release asset was present when this guide was updated.** The original author's locally built Preview EXEs are not downloadable from this repository.

**Future installers:** compare this dated snapshot with the current actual repository files, published releases and locally built version before giving channel commands; later verified code takes precedence.


## 3. Build and launch the Windows desktop application from source

**Both Codex and ChatGPT paths follow the same verified installation stages.** Codex can perform a stage only if it truly has authorized local Windows terminal access; otherwise the user performs it manually.

Official prerequisites:

- Windows 10/11 and Microsoft WebView2 runtime.
- Git: https://git-scm.com/downloads/win
- Node.js 20+ and npm: https://nodejs.org/
- Rust stable (rustup): https://rustup.rs/
- Microsoft C++ Build Tools, **Desktop development with C++** workload.
- PowerShell 7 recommended (Windows PowerShell may work where supported).
- Tauri Windows prerequisites: https://v2.tauri.app/start/prerequisites/

**Install/check prerequisites one at a time.** Follow official installers, explain privilege prompts, and ask before installing software. Never guess that a dependency is present.

With the user, choose a safe, user-writable **non-existing** project checkout path. Do not replace any existing directory or GP installation. Perform each stage individually and verify the exit code/output before proceeding:

1. Clone the official source repository using `git clone https://github.com/saintdivinity-sys/GPT-POWERSHELL.loop.git` from an approved parent directory. Record its actual checkout location and commit.
2. Within that checkout run `npm ci` (`package-lock.json` is included).
3. Verify frontend compilation with `npm run build`.
4. Create a Windows desktop executable with `npm run desktop:build -- --no-bundle`. This invokes the Rust/Tauri build; it may take substantial time and disk space. **The frontend command alone does not make an EXE.**
5. If using default Rust target settings, check the actual file at `src-tauri\\target\\release\\gpt-powershell-loop.exe`. If `CARGO_TARGET_DIR` is set, follow that directory instead. Confirm build exit code 0, file existence and exact path before launching.
6. Start the desktop EXE as the normal Windows user. Select the desired channel/port before starting its Bridge (CH1: 47177, CH2: 47178, CH3: 47179), click Start Bridge, and verify the actual listener. If a port is already occupied, investigate; do not kill another GP process without permission.

**What was installed?** `--no-bundle` builds a runnable EXE, **not an MSI/NSIS setup installer**. A real downloadable installer requires a separate build/publish process, verification and a public GitHub Release asset. Do not claim a release is available simply because the source builds locally.

**ChatGPT path only:** for a manual PowerShell command whose output must be pasted, capture stdout+stderr, print it and copy it to the clipboard, e.g. `$__g1 = (& { <ONE COMMAND> } 2>&1 | Out-String); $__g1; Set-Clipboard -Value $__g1`. Record native process exit status explicitly when important. Wait for the pasted output before continuing.


## 4. Install the ChatGPT browser extension

The official repository includes an unpacked **Chromium Manifest V3** extension at `browser-extension/`. Keep the clone in a stable location: moving or deleting the directory can break the loaded extension.

1. Open your browser's extensions page: **Opera GX:** `opera://extensions`; **Chrome:** `chrome://extensions`; **Edge:** `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked / Загрузить распакованное** and select the `browser-extension` folder inside the actual cloned repository (it must contain `manifest.json`).
4. Confirm **GPT-POWERSHELL.loop Bridge** is enabled; review the extension's requested permissions.
5. Open or refresh https://chatgpt.com/ after loading the extension.
6. Open the extension **toolbar popup** (puzzle/extension icon), not just the on-page floating badge. Choose `01`, `02`, `03`, or `OFF` for this ChatGPT tab. Set the desktop Bridge port to match the channel selected in the tab.
7. Confirm the desktop app is genuinely listening on the chosen port before testing commands. `OFF` disables automation for the tab; it does **not** shut down the desktop application.

If your installed extension has no three-channel popup, inspect the actual files and reload the extension. An old unpacked extension or a mismatched install may be active. Do not assume the UI alone proves a Bridge connection.

**Multi-instance caution:** A port can be owned by only one listener at a time. Do not start a competing listener or terminate an existing GP instance without permission.

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

- **Channel 1 (current source, legacy markers also supported):** tell ChatGPT: `Используем протокол GP. У меня установлена публичная одноканальная версия, порт 47177. Дай одну безопасную команду для проверки.`
- **Channel 2 (current multichannel source):** select CH2 in the extension, start the CH2 desktop listener on `47178`, then tell ChatGPT: `Используем протокол GP, канал 2. Проведи безопасный тест через GPTPS_EXEC:2.`
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
| No 01/02/03 buttons in popup | Current public source includes a channel popup; check whether an older extension was loaded, reload the unpacked extension and refresh ChatGPT |
| Build fails | Record the actual command, exit code, last lines of saved log, Node/Rust/MSVC versions; do not repeat expensive builds blindly |
| Huge command output freezes a tab | Save verbose detail into a local file and return a concise summary only |
| GPT does not know GP in a new chat | Check Custom Instructions were saved, then explicitly activate GP in that chat |
| Safety gate rejects a command | Review its risk, propose safer alternatives; do not work around safety protections |

The GP bridge is **not a VM or sandbox**. It executes PowerShell with the privileges of the Windows account running it. Output and other data included in the ChatGPT chat are sent to the ChatGPT service through the browser; do not send passwords, private keys or confidential logs by accident. Use at your own risk; inspect commands before allowing execution.

## 8. Notes for maintainers

- This public onboarding file is intentionally **independent of private Mind Palace / Game1 project documentation**.
- Do not copy private project paths, local executable previews, credentials, tokens or internal repository details into public instructions.
- Before calling a feature "released", verify public GitHub source **and** distributable assets.
- Keep this document and public README aligned with the published multichannel source. Do not claim packaged release availability until actual assets exist; document checksums when supplied.
- Project design discussions and live installation are different: reading this document is not itself user consent to execute commands.

**Version of this guide:** 2026-10-08. The live public repository and actual tested installed artifacts take precedence over any dated compatibility note here. Latest guide revision documents public main at 37de51f and the Codex/ChatGPT source-build choice.
