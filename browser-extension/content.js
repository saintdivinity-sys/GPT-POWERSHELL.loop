(() => {
  const seen = new Set();
  const attentionSeen = new Set();
  const ATTENTION_STABLE_MS = 4000;
  const MARKER_RENDER_GRACE_MS = 15000;
  const STARTUP_BASELINE_STABLE_MS = 5000;
  const TAB_ENABLED_KEY = "gptps-tab-enabled-v1";
  let startupBaselineSignature = "";
  let startupBaselineStableSince = 0;
  let startupBaselineActive = true;
  let busy = false;
  let scanTimer = null;
  let badge = null;
  let badgeText = null;
  let tabToggle = null;
  let badgeVisible = true;
  let tabEnabled = sessionStorage.getItem(TAB_ENABLED_KEY) !== "0";
  let attentionCandidate = null;
  let commandCandidate = null;

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").trim();
  }

  function applyBadgeVisibility() {
    if (!badge) return;
    badge.style.display = badgeVisible ? "flex" : "none";
  }

  function setBadge(text, state = "idle") {
    if (!badge || !badgeText) return;
    badgeText.textContent = text;
    const colors = {
      idle: ["rgba(12,18,22,.88)", "#bde5bd", "rgba(120,200,120,.55)"],
      sending: ["rgba(28,24,10,.92)", "#ffe69a", "rgba(230,190,80,.65)"],
      ok: ["rgba(10,28,18,.92)", "#bdf5cd", "rgba(100,220,140,.7)"],
      error: ["rgba(35,12,12,.94)", "#ffb7b7", "rgba(230,90,90,.75)"],
      result: ["rgba(12,22,34,.94)", "#b9d9ff", "rgba(100,160,230,.75)"],
      attention: ["rgba(38,27,8,.95)", "#ffe5a3", "rgba(235,181,71,.82)"],
      off: ["rgba(18,18,18,.88)", "#b9b9b9", "rgba(150,150,150,.55)"]
    };
    const [background, color, borderColor] = colors[state] || colors.idle;
    Object.assign(badge.style, { background, color, borderColor });
    applyBadgeVisibility();
  }

  function baselineCurrentMessages() {
    for (const message of assistantMessages()) {
      const key = stableKey(message);
      if (!key) continue;
      seen.add(key);
      attentionSeen.add(key);
    }
  }

  function renderTabToggle() {
    if (!tabToggle) return;
    tabToggle.textContent = tabEnabled ? "OFF" : "ON";
    tabToggle.title = tabEnabled
      ? "Disable GPT-POWERSHELL.loop for this tab"
      : "Enable GPT-POWERSHELL.loop for this tab";
    tabToggle.setAttribute("aria-pressed", String(tabEnabled));
  }

  function wakeBridge() {
    if (!tabEnabled) return;

    chrome.runtime.sendMessage({ type: "GPTPS_TAB_HELLO" }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (!tabEnabled) return;

      if (runtimeError) {
        console.warn("[GPTPS] extension background wake failed", runtimeError.message);
        setBadge("GPT↔PS EXT ERR", "error");
        return;
      }

      if (response?.connected) {
        setBadge("GPT↔PS READY", "ok");
      } else {
        setBadge("GPT↔PS BRIDGE…", "sending");
      }
    });
  }

  function setTabEnabled(nextEnabled) {
    const next = Boolean(nextEnabled);
    if (tabEnabled === next) return;

    tabEnabled = next;
    sessionStorage.setItem(TAB_ENABLED_KEY, tabEnabled ? "1" : "0");
    attentionCandidate = null;
    commandCandidate = null;

    renderTabToggle();

    if (!tabEnabled) {
      setBadge("GPT↔PS OFF", "off");
      return;
    }

    // Enabling a tab must never replay an already-rendered assistant command.
    baselineCurrentMessages();
    startupBaselineActive = false;
    setBadge("GPT↔PS READY", "ok");
    wakeBridge();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  function assistantMessages() {
    // Legacy ChatGPT DOM exposed explicit assistant-role nodes inside
    // conversation-turn <article> elements.
    const roleNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const legacyMessages = [];
    const legacyUnique = new Set();

    for (const node of roleNodes) {
      const container = node.closest('article[data-testid^="conversation-turn-"]') || node;
      if (legacyUnique.has(container)) continue;
      legacyUnique.add(container);
      legacyMessages.push(container);
    }

    if (legacyMessages.length > 0) {
      return legacyMessages;
    }

    // Current ChatGPT DOM (Sep 2026) no longer exposes either
    // data-message-author-role="assistant" or conversation-turn <article>
    // wrappers. Assistant answers are rendered through a MarkdownRoot-* node.
    // Use the markdown root itself as the message container; it preserves DOM
    // order and contains the rendered code blocks needed by GPTPS extraction.
    const markdownRoots = [...document.querySelectorAll('div[class*="MarkdownRoot-"]')];
    const fallbackMessages = [];
    const fallbackUnique = new Set();

    for (const root of markdownRoots) {
      if (fallbackUnique.has(root)) continue;
      fallbackUnique.add(root);
      fallbackMessages.push(root);
    }

    return fallbackMessages;
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
    const markerCandidates = ["GPTPS_EXEC", "GPTPS_HIGH"]
      .map((marker) => ({ marker, index: full.indexOf(marker) }))
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => a.index - b.index);

    if (markerCandidates.length === 0) return null;
    const { marker, index: markerIndex } = markerCandidates[0];

    // ChatGPT's code-block DOM has changed across UI versions. Prefer the
    // actual <code> child when present, but also support a bare <pre> fallback.
    // The fallback strips a visual language-label first line such as
    // "PowerShell" so it can never become part of the executed command.
    const candidates = [];
    for (const pre of article.querySelectorAll("pre")) {
      const codeNode = pre.querySelector("code");
      let code = codeNode ? textOf(codeNode) : textOf(pre);
      if (!code) continue;

      let lines = code.replace(/\r\n/g, "\n").split("\n");
      if (lines.length > 1 && /^(powershell|pwsh|shell|bash|cmd|command prompt)$/i.test(lines[0].trim())) {
        lines = lines.slice(1);
      }
      code = lines.join("\n").trim();
      if (code) candidates.push({ node: codeNode || pre, code });
    }

    // Some ChatGPT variants expose code elements without the expected <pre>
    // relationship. Add them as a secondary fallback without duplicating text.
    for (const codeNode of article.querySelectorAll("code")) {
      const code = textOf(codeNode).trim();
      if (!code || candidates.some((entry) => entry.code === code)) continue;
      candidates.push({ node: codeNode, code });
    }

    for (const { node, code } of candidates) {
      if (/^(powershell|pwsh|shell|bash|cmd|command prompt|GPTPS_EXEC|GPTPS_HIGH)$/i.test(code)) continue;

      const className = (node.className || "").toLowerCase();
      const parentClass = (node.parentElement?.className || "").toLowerCase();
      const looksPowerShell =
        className.includes("powershell") ||
        className.includes("language-powershell") ||
        parentClass.includes("powershell") ||
        /\b(Get-|Set-|New-|Test-|Invoke-|Start-|Stop-|Remove-|Copy-|Move-|Write-|Out-|Select-|Where-|ForEach-|cmd\.exe|pwsh|powershell|\[Environment\]::)\b/i.test(code) ||
        /\$[A-Za-z_][A-Za-z0-9_]*/.test(code);

      if (!looksPowerShell) continue;
      return { command: code, marker };
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
    if (!current || current.key !== next.key || current.text !== next.text || current.command !== next.command || current.marker !== next.marker) {
      return { stable: false, value: { ...next, since: Date.now() } };
    }

    return {
      stable: Date.now() - current.since >= requiredMs,
      value: current
    };
  }

  function sendAttention(key, text, observedAtMs) {
    if (attentionSeen.has(key)) return;

    chrome.runtime.sendMessage({
      type: "GPTPS_ATTENTION_REQUIRED",
      payload: {
        type: "attention_required",
        assistant_text: text.slice(0, 12000),
        observed_at_ms: observedAtMs
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
    if (!tabEnabled) {
      attentionCandidate = null;
      commandCandidate = null;
      setBadge("GPT↔PS OFF", "off");
      return;
    }

    if (busy) return;

    // ChatGPT hydrates conversation history asynchronously after a page or
    // extension reload. Do not use a fixed wall-clock window here: document_idle
    // can run several seconds before React finishes restoring old turns.
    //
    // Instead, keep baselining every assistant turn that appears until the
    // assistant-history key set has remained unchanged for a quiet period.
    if (startupBaselineActive) {
      const historyMessages = assistantMessages();
      const historyKeys = [];

      for (const message of historyMessages) {
        const historyKey = stableKey(message);
        if (!historyKey) continue;

        historyKeys.push(historyKey);
        seen.add(historyKey);
        attentionSeen.add(historyKey);
      }

      attentionCandidate = null;
      commandCandidate = null;

      const historySignature = historyKeys.join("|");

      if (historySignature !== startupBaselineSignature) {
        startupBaselineSignature = historySignature;
        startupBaselineStableSince = Date.now();
      }

      const historyStable =
        historyKeys.length > 0 &&
        startupBaselineStableSince > 0 &&
        (Date.now() - startupBaselineStableSince) >= STARTUP_BASELINE_STABLE_MS;

      if (!historyStable || isGenerating()) {
        setBadge("GPT↔PS SYNC", "idle");
        return;
      }

      startupBaselineActive = false;
      setBadge("GPT↔PS READY", "ok");
    }

    const messages = assistantMessages();
    const last = messages[messages.length - 1];
    if (!last) return;

    const key = stableKey(last);
    if (!key) return;

    const full = textOf(last);
    const marked = extractMarkedPowerShell(last);

    if (!marked) {
      commandCandidate = null;
      if (!full || attentionSeen.has(key) || seen.has(key)) return;

      // A protocol marker is rendered before ChatGPT's <pre><code> block can
      // become queryable. Treat that as an in-progress command turn rather
      // than immediately arming ATTENTION, otherwise AUTO SAFE can pause in
      // the small gap between marker text and finalized code-block DOM.
      const markerPending = full.includes("GPTPS_EXEC") || full.includes("GPTPS_HIGH");

      // Protocol invariant: once a strict GP marker is visible in this
      // assistant turn, this turn is a command turn, never an ATTENTION turn.
      // If its code block is still rendering (or temporarily unrecognized),
      // keep rescanning instead of pausing AUTO SAFE.
      if (markerPending) {
        attentionCandidate = null;
        setBadge("GPT↔PS WAIT CMD", "sending");
        return;
      }

      const next = { key, text: full, command: null, marker: null };
      const check = noteStableCandidate(attentionCandidate, next, ATTENTION_STABLE_MS);
      attentionCandidate = check.value;

      if (isGenerating() || !check.stable) return;
      sendAttention(key, full, check.value.since);
      return;
    }

    attentionCandidate = null;
    if (seen.has(key)) return;

    const { command, marker } = marked;
    const next = { key, text: full, command, marker };
    const check = noteStableCandidate(commandCandidate, next, 1500);
    commandCandidate = check.value;

    // Do not execute during streaming. The complete assistant turn must also
    // remain unchanged for 1.5 seconds before being eligible.
    if (isGenerating() || !check.stable) return;

    commandCandidate = null;
    busy = true;
    setBadge(marker === "GPTPS_HIGH" ? "GPT↔PS HIGH…" : "GPT↔PS SEND…", marker === "GPTPS_HIGH" ? "error" : "sending");

    chrome.runtime.sendMessage({
      type: "GPTPS_ASSISTANT_COMMAND",
      payload: {
        type: "assistant_command",
        marker,
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
      if (!tabEnabled) return;
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

  badgeText = document.createElement("span");
  badgeText.textContent = "GPT↔PS";

  tabToggle = document.createElement("button");
  tabToggle.id = "gptps-tab-toggle";
  tabToggle.type = "button";

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
    pointerEvents: "auto",
    alignItems: "center",
    gap: "6px",
    userSelect: "none"
  });

  Object.assign(tabToggle.style, {
    display: "none",
    padding: "2px 5px",
    border: "1px solid rgba(255,255,255,.2)",
    borderRadius: "5px",
    background: "rgba(255,255,255,.08)",
    color: "inherit",
    font: "10px/1.2 system-ui,sans-serif",
    cursor: "pointer"
  });

  badge.addEventListener("mouseenter", () => {
    if (tabToggle) tabToggle.style.display = "inline-block";
  });

  badge.addEventListener("mouseleave", () => {
    if (tabToggle) tabToggle.style.display = "none";
  });

  tabToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setTabEnabled(!tabEnabled);
  });

  badge.appendChild(badgeText);
  badge.appendChild(tabToggle);
  document.documentElement.appendChild(badge);
  renderTabToggle();

  chrome.storage.local.get({ badgeVisible: true }, (result) => {
    badgeVisible = result.badgeVisible !== false;
    applyBadgeVisibility();
  });

  // Everything already on the page when the extension starts is history.
  // Baseline it so extension reload/page refresh cannot replay an old command.
  baselineCurrentMessages();

  if (tabEnabled) {
    wakeBridge();
  } else {
    setBadge("GPT↔PS OFF", "off");
  }
})();