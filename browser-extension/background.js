const PORT = 47177;
let socket = null;
let reconnectTimer = null;
let pingTimer = null;

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
      const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
      const tab = tabs.find((candidate) => candidate.active) || tabs[0];
      if (!tab?.id) return;

      chrome.tabs.sendMessage(tab.id, {
        type: "GPTPS_COMMAND_RESULT",
        payload
      });
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GPTPS_ASSISTANT_COMMAND") return;

  connect();

  const send = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "local bridge is not connected" });
      return;
    }

    socket.send(JSON.stringify(message.payload));
    sendResponse({ ok: true });
  };

  if (socket?.readyState === WebSocket.CONNECTING) {
    setTimeout(send, 500);
    return true;
  }

  send();
  return true;
});

connect();
