# Architecture

```text
ChatGPT web page
    ↕
Chromium MV3 content script
    ↕
MV3 background service worker
    ↕ WebSocket / loopback
Tauri desktop application
    ├── loop state
    ├── safety classifier
    ├── JSONL logging
    └── PowerShell runner
```

## Design constraints

- no cloud relay is required;
- no global keyboard/mouse automation is required for the normal loop;
- explicit marker is the source of execution intent;
- STEP is safer than AUTO and remains the first-run behavior;
- unsafe/ambiguous states pause;
- browser DOM integration is an adapter and may need maintenance when ChatGPT UI changes.

## Future window framing

The planned Windows UI may let the user select ChatGPT and terminal windows by HWND and draw a transparent always-on-top frame around them. That framing is presentation/selection only; command transport should remain direct rather than clicking and typing into arbitrary windows.
