const PORT = 47177;
let socket = null;
let reconnectTimer = null;
let pingTimer = null;
const pendingTabIds = [];

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping" }));
    }
  }, 20000);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(`ws://127.0.0.1:${PORT}`);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", page_url: "https://chatgpt.com/" }));
    startPing();
  });

  socket.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "command_result") {
      const tabId = pendingTabIds.shift();
      if (!tabId) {
        console.warn("[GPTPS] command_result received without an originating ChatGPT tab");
        return;
      }

      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "GPTPS_COMMAND_RESULT",
          payload
        });
      } catch (error) {
        console.warn("[GPTPS] failed to return command result to originating tab", error);
      }
      return;
    }

    if (payload.type === "paused" || payload.type === "blocked" || payload.type === "error") {
      const tabId = pendingTabIds.shift();
      if (!tabId) {
        console.warn("[GPTPS] bridge status received without an originating ChatGPT tab", payload);
        return;
      }

      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "GPTPS_BRIDGE_STATUS",
          payload
        });
      } catch (error) {
        console.warn("[GPTPS] failed to return bridge status to originating tab", error);
      }
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  });

  socket.addEventListener("error", () => {
    try { socket.close(); } catch {}
  });
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isCommand = message?.type === "GPTPS_ASSISTANT_COMMAND";
  const isAttention = message?.type === "GPTPS_ATTENTION_REQUIRED";
  if (!isCommand && !isAttention) return;

  connect();

  const send = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "local bridge is not connected" });
      return;
    }

    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "originating ChatGPT tab is unavailable" });
      return;
    }

    if (isCommand) {
      pendingTabIds.push(tabId);
    }

    socket.send(JSON.stringify(message.payload));
    sendResponse({ ok: true, tab_id: tabId });
  };

  if (socket?.readyState === WebSocket.CONNECTING) {
    setTimeout(send, 500);
    return true;
  }

  send();
  return true;
});

connect();
