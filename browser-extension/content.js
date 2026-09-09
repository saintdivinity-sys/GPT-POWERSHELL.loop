(() => {
  const seen = new Set();
  let busy = false;
  let scanTimer = null;
  let badge = null;

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
      result: ["rgba(12,22,34,.94)", "#b9d9ff", "rgba(100,160,230,.75)"]
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

  async function scan() {
    if (busy) return;

    const messages = assistantMessages();
    const last = messages[messages.length - 1];
    if (!last) return;

    const key = stableKey(last);
    if (!key || seen.has(key)) return;

    const command = extractMarkedPowerShell(last);
    if (!command) return;

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

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const button = findSendButton();
      if (button && !button.disabled) {
        button.click();
        setBadge("GPT↔PS SENT BACK", "ok");
        return;
      }
    }

    const form = composer.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
        setBadge("GPT↔PS SENT BACK", "ok");
        return;
      } catch (error) {
        console.warn("[GPTPS] requestSubmit fallback failed", error);
      }
    }

    console.warn("[GPTPS] send button unavailable after waiting; result left in composer");
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
})();
