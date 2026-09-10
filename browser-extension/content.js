(() => {
  const seen = new Set();
  const attentionSeen = new Set();
  let busy = false;
  let scanTimer = null;
  let badge = null;
  let badgeVisible = true;
  let attentionCandidate = null;
  let commandCandidate = null;

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").trim();
  }

  function applyBadgeVisibility() {
    if (!badge) return;
    badge.style.display = badgeVisible ? "block" : "none";
  }

  function setBadge(text, state = "idle") {
    if (!badge) return;
    badge.textContent = text;
    const colors = {
      idle: ["rgba(12,18,22,.88)", "#bde5bd", "rgba(120,200,120,.55)"],
      sending: ["rgba(28,24,10,.92)", "#ffe69a", "rgba(230,190,80,.65)"],
      ok: ["rgba(10,28,18,.92)", "#bdf5cd", "rgba(100,220,140,.7)"],
      error: ["rgba(35,12,12,.94)", "#ffb7b7", "rgba(230,90,90,.75)"],
      result: ["rgba(12,22,34,.94)", "#b9d9ff", "rgba(100,160,230,.75)"],
      attention: ["rgba(38,27,8,.95)", "#ffe5a3", "rgba(235,181,71,.82)"]
    };
    const [background, color, borderColor] = colors[state] || colors.idle;
    Object.assign(badge.style, { background, color, borderColor });
    applyBadgeVisibility();
  }

  function assistantMessages() {
    const roleNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const messages = [];
    const unique = new Set();

    for (const node of roleNodes) {
      const container = node.closest('article[data-testid^="conversation-turn-"]') || node;
      if (unique.has(container)) continue;
      unique.add(container);
      messages.push(container);
    }

    return messages;
  }

  function stableKey(article) {
    const ownMessageId = article.getAttribute?.("data-message-id");
    if (ownMessageId) return `message:${ownMessageId}`;

    const nestedMessageId = article.querySelector?.("[data-message-id]")?.getAttribute?.("data-message-id");
    if (nestedMessageId) return `message:${nestedMessageId}`;

    const testId = article.getAttribute?.("data-testid");
    if (testId) return `turn:${testId}`;

    const text = textOf(article);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fallback:${(hash >>> 0).toString(16)}:${text.length}`;
  }

  function extractMarkedPowerShell(article) {
    const full = textOf(article);
    const marker = "GPTPS_EXEC";
    const markerIndex = full.indexOf(marker);
    if (markerIndex < 0) return null;

    // Only use actual code nodes. Bare <pre> may include ChatGPT's visual
    // language header and was observed to execute the literal word "PowerShell".
    const blocks = [...article.querySelectorAll("pre code")];
    for (const block of blocks) {
      const code = textOf(block);
      if (!code) continue;

      const trimmed = code.trim();
      if (/^(powershell|pwsh|shell|bash|cmd|command prompt)$/i.test(trimmed)) {
        continue;
      }

      const className = (block.className || "").toLowerCase();
      const parentClass = (block.parentElement?.className || "").toLowerCase();
      const looksPowerShell =
        className.includes("powershell") ||
        className.includes("language-powershell") ||
        parentClass.includes("powershell") ||
        /\b(Get-|Set-|New-|Test-|Invoke-|Start-|Stop-|Remove-|Copy-|Move-|Write-|Out-|Select-|Where-|ForEach-|cmd\.exe|pwsh|powershell|\[Environment\]::)\b/i.test(code) ||
        /\$[A-Za-z_][A-Za-z0-9_]*/.test(code);

      if (!looksPowerShell) continue;

      // The executable block must appear after GPTPS_EXEC in the same assistant turn.
      const codeIndex = full.indexOf(trimmed, markerIndex + marker.length);
      if (codeIndex < 0) continue;

      return code;
    }

    return null;
  }

  function isGenerating() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Остановить"]',
      'button[aria-label*="Stop"]'
    ];

    return selectors.some((selector) => document.querySelector(selector));
  }

  function noteStableCandidate(current, next, requiredMs) {
    if (!current || current.key !== next.key || current.text !== next.text || current.command !== next.command) {
      return { stable: false, value: { ...next, since: Date.now() } };
    }

    return {
      stable: Date.now() - current.since >= requiredMs,
      value: current
    };
  }

  function sendAttention(key, text) {
    if (attentionSeen.has(key)) return;

    chrome.runtime.sendMessage({
      type: "GPTPS_ATTENTION_REQUIRED",
      payload: {
        type: "attention_required",
        assistant_text: text.slice(0, 12000)
      }
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response?.ok) {
        console.warn("[GPTPS] attention event was not accepted by extension background", runtimeError?.message || response?.error || response);
        return;
      }

      attentionSeen.add(key);
      setBadge("GPT↔PS ATTENTION", "attention");
    });
  }

  async function scan() {
    if (busy) return;

    const messages = assistantMessages();
    const last = messages[messages.length - 1];
    if (!last) return;

    const key = stableKey(last);
    if (!key) return;

    const full = textOf(last);
    const command = extractMarkedPowerShell(last);

    if (!command) {
      commandCandidate = null;
      if (!full || attentionSeen.has(key) || seen.has(key)) return;

      const next = { key, text: full, command: null };
      const check = noteStableCandidate(attentionCandidate, next, 2500);
      attentionCandidate = check.value;

      if (isGenerating() || !check.stable) return;
      sendAttention(key, full);
      return;
    }

    attentionCandidate = null;
    if (seen.has(key)) return;

    const next = { key, text: full, command };
    const check = noteStableCandidate(commandCandidate, next, 1500);
    commandCandidate = check.value;

    // Do not execute during streaming. The complete assistant turn must also
    // remain unchanged for 1.5 seconds before being eligible.
    if (isGenerating() || !check.stable) return;

    commandCandidate = null;
    busy = true;
    setBadge("GPT↔PS SEND…", "sending");

    chrome.runtime.sendMessage({
      type: "GPTPS_ASSISTANT_COMMAND",
      payload: {
        type: "assistant_command",
        marker: "GPTPS_EXEC",
        command,
        assistant_text: full.slice(0, 12000)
      }
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError || !response?.ok) {
        console.warn("[GPTPS] command was not accepted by extension background", runtimeError?.message || response?.error || response);
        setBadge("GPT↔PS ERR", "error");
        busy = false;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 1500);
        return;
      }

      seen.add(key);
      setBadge("GPT↔PS SENT", "ok");
      busy = false;
    });
  }

  function findComposer() {
    return document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid="prompt-textarea"]') ||
      document.querySelector('div[contenteditable="true"][data-testid*="prompt"]') ||
      document.querySelector('div[contenteditable="true"]');
  }

  function setComposerText(element, text) {
    element.focus();

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Отправ"]',
      'form button[type="submit"]'
    ];

    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button) return button;
    }

    return null;
  }

  function resultStillInComposer(body) {
    const composer = findComposer();
    if (!composer) return false;
    const current = textOf(composer);
    if (!current) return false;
    return current.includes("GPTPS_RESULT") || current.includes(body.slice(0, 80));
  }

  async function waitForSubmission(body, timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!resultStillInComposer(body)) return true;
    }
    return false;
  }

  async function trySubmitResult(composer, body) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const button = findSendButton();
      if (!button || button.disabled) continue;

      button.click();
      if (await waitForSubmission(body)) return true;

      const form = composer.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        try {
          form.requestSubmit(button);
          if (await waitForSubmission(body)) return true;
        } catch (error) {
          console.warn("[GPTPS] requestSubmit(button) failed", error);
        }
      }

      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      composer.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      if (await waitForSubmission(body)) return true;
    }

    return false;
  }

  async function submitResult(payload) {
    setBadge("GPT↔PS RESULT", "result");

    const composer = findComposer();
    if (!composer) {
      console.warn("[GPTPS] composer not found; result was not submitted");
      setBadge("GPT↔PS RESULT ERR", "error");
      return;
    }

    const body = [
      "GPTPS_RESULT",
      `cycle_id: ${payload.cycle_id}`,
      `exit_code: ${payload.exit_code}`,
      "",
      "STDOUT:",
      payload.stdout || "(empty)",
      "",
      "STDERR:",
      payload.stderr || "(empty)"
    ].join("\n");

    setComposerText(composer, body);

    if (await trySubmitResult(composer, body)) {
      setBadge("GPT↔PS SENT BACK", "ok");
      return;
    }

    console.warn("[GPTPS] automatic result submission did not complete; result left in composer");
    setBadge("GPT↔PS RESULT WAIT", "error");
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "GPTPS_COMMAND_RESULT") {
      submitResult(message.payload);
      return;
    }

    if (message?.type === "GPTPS_BRIDGE_STATUS") {
      const payload = message.payload || {};
      const detail = payload.message || payload.reason || payload.type || "bridge error";
      console.warn("[GPTPS] bridge status:", detail);
      setBadge(`GPT↔PS ${String(payload.type || "ERR").toUpperCase()}`, "error");
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.badgeVisible) return;
    badgeVisible = changes.badgeVisible.newValue !== false;
    applyBadgeVisibility();
  });

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 1500);

  badge = document.createElement("div");
  badge.id = "gptps-status-badge";
  badge.textContent = "GPT↔PS";
  Object.assign(badge.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    padding: "6px 9px",
    border: "1px solid rgba(120,200,120,.55)",
    borderRadius: "8px",
    background: "rgba(12,18,22,.88)",
    color: "#bde5bd",
    font: "11px/1.2 system-ui,sans-serif",
    pointerEvents: "none"
  });
  document.documentElement.appendChild(badge);

  chrome.storage.local.get({ badgeVisible: true }, (result) => {
    badgeVisible = result.badgeVisible !== false;
    applyBadgeVisibility();
  });

  // Everything already on the page when the extension starts is history.
  // Baseline it so extension reload/page refresh cannot replay an old command.
  for (const message of assistantMessages()) {
    const key = stableKey(message);
    if (!key) continue;
    seen.add(key);
    attentionSeen.add(key);
  }
})();
