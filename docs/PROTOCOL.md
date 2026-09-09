# Local protocol

Transport: WebSocket bound to loopback only.

Default endpoint:

```text
ws://127.0.0.1:47177
```

## Assistant command

```json
{
  "type": "assistant_command",
  "marker": "GPTPS_EXEC",
  "command": "Get-ChildItem",
  "assistant_text": "optional surrounding assistant text"
}
```

## Command result

```json
{
  "type": "command_result",
  "cycle_id": "uuid",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "started_at": "RFC3339",
  "finished_at": "RFC3339"
}
```

## Fail-closed behavior

If the bridge is paused/stopped, the execution marker is missing, a high-risk pattern is detected, PowerShell times out, or browser DOM selectors fail, the automation must pause rather than invent a recovery action.
