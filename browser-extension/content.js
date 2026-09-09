(() => {
  const seen = new Set();
  let busy = false;
  let scanTimer = null;

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").trim();
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

    seen.add(key);
    busy = true;

    chrome.runtime.sendMessage({
      type: "GPTPS_ASSISTANT_COMMAND",
      payload: {
        type: "assistant_command",
        marker: "GPTPS_EXEC",
        command,
        assistant_text: textOf(last).slice(0, 12000)
      }
    }, () => {
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
    return document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="Отправ"]');
  }

  async function submitResult(payload) {
    const composer = findComposer();
    if (!composer) {
      console.warn("[GPTPS] composer not found; result was not submitted");
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
    await new Promise((resolve) => setTimeout(resolve, 150));

    const button = findSendButton();
    if (!button || button.disabled) {
      console.warn("[GPTPS] send button unavailable; result left in composer");
      return;
    }

    button.click();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "GPTPS_COMMAND_RESULT") {
      submitResult(message.payload);
    }
  });

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 1500);

  const badge = document.createElement("div");
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
