(() => {
  const seen = new Set();
  const attentionSeen = new Set();
  let busy = false;
  let scanTimer = null;
  let badge = null;
  let attentionCandidate = null;
  let initialAttentionKey = null;

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").trim();
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
  }

  function extractMarkedPowerShell(article) {
    const full = textOf(article);
    if (!full.includes("GPTPS_EXEC")) return null;

    const blocks = [...article.querySelectorAll("pre code, pre")];
    for (const block of blocks) {
      const code = textOf(block);
      if (!code) continue;

      const className = (block.className || "").toLowerCase();
      const looksPowerShell =
        className.includes("powershell") ||
        className.includes("language-powershell") ||
        /\b(Get-|Set-|New-|Test-|Invoke-|Start-|Stop-|Remove-|Copy-|Move-|Write-|cd\s|pwsh|powershell)\b/i.test(code);

      if (looksPowerShell) return code;
    }

    return null;
  }

  function assistantMessages() {
    return [...document.querySelectorAll(
      'article[data-testid^="conversation-turn-"], [data-message-author-role="assistant"]'
    )];
  }

  function stableKey(article) {
    return article.getAttribute("data-testid") ||
      article.getAttribute("data-message-id") ||
      textOf(article).slice(0, 220);
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

  function noteAttentionCandidate(key, text) {
    if (!attentionCandidate || attentionCandidate.key !== key || attentionCandidate.text !== text) {
      attentionCandidate = { key, text, since: Date.now() };
      return false;
    }

    return Date.now() - attentionCandidate.since >= 2500;
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

    const command = extractMarkedPowerShell(last);
    if (!command) {
      const full = textOf(last);
      if (!full || attentionSeen.has(key) || key === initialAttentionKey) return;
      if (isGenerating()) {
        noteAttentionCandidate(key, full);
        return;
      }

      if (noteAttentionCandidate(key, full)) {
        sendAttention(key, full);
      }
      return;
    }

    attentionCandidate = null;
    if (seen.has(key)) return;

    busy = true;
    setBadge("GPT↔PS SEND…", "sending");

    chrome.runtime.sendMessage({
      type: "GPTPS_ASSISTANT_COMMAND",
      payload: {
        type: "assistant_command",
        marker: "GPTPS_EXEC",
        command,
        assistant_text: textOf(last).slice(0, 12000)
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

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 1500);

  badge = document.createElement("div");
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

  const currentMessages = assistantMessages();
  const currentLast = currentMessages[currentMessages.length - 1];
  initialAttentionKey = currentLast ? stableKey(currentLast) : null;
})();
