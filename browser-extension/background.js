"use strict";

const CHANNEL_PORTS = Object.freeze({
  1: 47177,
  2: 47178,
  3: 47179
});

const states = new Map();
const owners = new Map();

for (const channel of [1, 2, 3]) {
  states.set(channel, {
    socket: null,
    reconnectTimer: null,
    pingTimer: null,
    pending: []
  });
}

function validChannel(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : null;
}

function commandChannel(marker) {
  const match = /^GPTPS_(?:EXEC|HIGH)(?::([123]))?$/.exec(
    String(marker || "")
  );
  return match ? Number(match[1] || 1) : null;
}

async function notify(tabId, type, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, { type, payload });
  } catch (error) {
    console.warn("[GPTPS] tab delivery failed", tabId, error);
  }
}

function clearPending(channel, reason) {
  const state = states.get(channel);

  for (const item of state.pending.splice(0)) {
    void notify(item.tabId, "GPTPS_BRIDGE_STATUS", {
      type: "error",
      channel,
      message: reason
    });
  }
}

function connect(channel) {
  const state = states.get(channel);
  if (!state) return;

  if (
    state.socket &&
    (state.socket.readyState === WebSocket.OPEN ||
     state.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearTimeout(state.reconnectTimer);

  const socket = new WebSocket(
    `ws://127.0.0.1:${CHANNEL_PORTS[channel]}`
  );

  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;

    socket.send(JSON.stringify({
      type: "hello",
      page_url: "https://chatgpt.com/",
      channel
    }));

    clearInterval(state.pingTimer);

    state.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);
  });

  socket.addEventListener("message", async (event) => {
    if (state.socket !== socket) return;

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const isResult = payload.type === "command_result";
    const isStatus = ["paused", "blocked", "error"].includes(
      payload.type
    );

    if (!isResult && !isStatus) return;

    const pending = state.pending.shift();

    if (!pending) {
      console.warn(
        `[GPTPS:${channel}] response without pending command`,
        payload
      );
      return;
    }

    const destination = pending.tabId;

    await notify(
      destination,
      isResult ? "GPTPS_COMMAND_RESULT" : "GPTPS_BRIDGE_STATUS",
      { ...payload, channel }
    );
  });

  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;

    state.socket = null;
    clearInterval(state.pingTimer);

    clearPending(
      channel,
      `Channel ${channel} bridge disconnected; result unavailable`
    );

    clearTimeout(state.reconnectTimer);

    if (channel === 1 || owners.has(channel)) {
      state.reconnectTimer = setTimeout(
        () => connect(channel),
        1500
      );
    }
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {}
  });
}

function waitForOpen(channel) {
  connect(channel);

  const state = states.get(channel);
  const socket = state.socket;

  if (socket?.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }

  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error("No socket"));
      return;
    }

    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve(socket);
    };

    const onOpen = () => finish(null);
    const onClose = () => finish(
      new Error("Bridge connection closed")
    );

    const timer = setTimeout(() => finish(
      new Error(`Channel ${channel} bridge connection timed out`)
    ), 4000);

    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);

    if (socket.readyState === WebSocket.OPEN) {
      finish(null);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => connect(1));
chrome.runtime.onStartup.addListener(() => connect(1));

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    const isCommand = message?.type === "GPTPS_ASSISTANT_COMMAND";
    const isAttention = message?.type === "GPTPS_ATTENTION_REQUIRED";
    const isHello = message?.type === "GPTPS_TAB_HELLO";

    if (message?.type === "GPTPS_TAB_UNBIND_CHANNEL") {
      const channel = validChannel(message.channel);
      const tabId = sender?.tab?.id;

      if (!channel || !tabId || owners.get(channel) !== tabId) {
        sendResponse({ ok: false, error: "No matching channel binding" });
        return true;
      }

      const pending = states.get(channel).pending.some(
        (item) => item.tabId === tabId
      );

      if (pending) {
        sendResponse({ ok: false, error: "Channel has a pending result" });
        return true;
      }

      owners.delete(channel);
      sendResponse({ ok: true, channel });
      return true;
    }

    if (!isCommand && !isAttention && !isHello) return;

    const markerChannel = isCommand
      ? commandChannel(message?.payload?.marker)
      : null;

    const explicitChannel = message?.channel ??
      message?.payload?.channel;

    const channel = isCommand
      ? markerChannel
      : validChannel(explicitChannel ?? 1);

    if (!channel) {
      sendResponse({
        ok: false,
        error: "Invalid GP channel or command marker"
      });
      return true;
    }

    if (
      explicitChannel != null &&
      validChannel(explicitChannel) !== channel
    ) {
      sendResponse({
        ok: false,
        error: "Command marker and tab channel mismatch"
      });
      return true;
    }

    const tabId = sender?.tab?.id;

    if (!tabId) {
      sendResponse({
        ok: false,
        error: "Originating ChatGPT tab is unavailable"
      });
      return true;
    }

    if (isHello) {
      void waitForOpen(channel).then(
        () => sendResponse({
          ok: true,
          channel,
          connected: true
        }),
        (error) => sendResponse({
          ok: true,
          channel,
          connected: false,
          error: String(error)
        })
      );
      return true;
    }

    const owner = owners.get(channel);

    if (owner != null && owner !== tabId) {
      sendResponse({
        ok: false,
        channel,
        error: `Channel ${channel} is bound to tab ${owner}`
      });
      return true;
    }

    owners.set(channel, tabId);

    void waitForOpen(channel).then(
      (socket) => {
        const state = states.get(channel);

        const wirePayload = {
          ...message.payload,
          channel
        };

        if (isCommand) {
          state.pending.push({ tabId });
        }

        try {
          socket.send(JSON.stringify(wirePayload));
          sendResponse({ ok: true, channel, tab_id: tabId });
        } catch (error) {
          if (isCommand) {
            const index = state.pending.findIndex(
              (item) => item.tabId === tabId
            );
            if (index >= 0) state.pending.splice(index, 1);
          }

          sendResponse({
            ok: false,
            channel,
            error: String(error)
          });
        }
      },
      (error) => sendResponse({
        ok: false,
        channel,
        error: String(error)
      })
    );

    return true;
  }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [channel, owner] of owners.entries()) {
    if (owner === tabId) owners.delete(channel);
  }
});

connect(1);
