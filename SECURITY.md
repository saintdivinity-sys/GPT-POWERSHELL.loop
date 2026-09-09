# Security

GPT-POWERSHELL.loop can execute local shell commands. Treat every auto-execution feature as privileged automation.

## Safe defaults

- strict `GPTPS_EXEC` marker required;
- STEP mode is the default;
- high-risk commands are blocked;
- commands time out;
- the bridge listens on loopback only;
- no credential scraping;
- no global mouse/keyboard hijacking.

## Important limitation

The command classifier is a heuristic guardrail, **not a sandbox**. Do not run GPT-POWERSHELL.loop elevated unless you actually need elevation.

## Vulnerability reports

Please use a private GitHub security advisory rather than publishing exploit details in a normal issue.
