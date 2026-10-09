
const toggle = document.getElementById("badgeToggle");
const stateLabel = document.getElementById("badgeState");
const buttons = [...document.querySelectorAll("[data-gp-channel]")];
const status = document.getElementById("gpChannelStatus");
const indicator = document.getElementById("connectionIndicator");
const routing = document.getElementById("routingStatus");
const port = document.getElementById("bridgePort");
const automation = document.getElementById("automationState");

function renderBadge(visible) {
  toggle.classList.toggle("off", !visible);
  toggle.setAttribute("aria-pressed", String(visible));
  stateLabel.textContent = visible
    ? "Floating badge visible"
    : "Floating badge hidden";
}

async function updateBadge() {
  const result = await chrome.storage.local.get({ badgeVisible: true });
  renderBadge(result.badgeVisible !== false);
}

toggle.addEventListener("click", async () => {
  const result = await chrome.storage.local.get({ badgeVisible: true });
  const next = result.badgeVisible === false;
  await chrome.storage.local.set({ badgeVisible: next });
  renderBadge(next);
});

async function tabMessage(message) {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  const tabId = tabs[0]?.id;

  if (!tabId) {
    throw new Error("No active ChatGPT tab");
  }

  return chrome.tabs.sendMessage(tabId, message);
}

function renderState(data) {
  const enabled = data.enabled !== false;
  const channel = enabled ? Number(data.channel) : 0;

  for (const button of buttons) {
    const selected = Number(button.dataset.gpChannel) === channel;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }

  status.textContent = enabled
    ? `Channel ${channel} selected for this tab`
    : "Automation OFF for this tab";

  if (data.pending) {
    status.textContent += " - command result pending";
  }

  indicator.textContent = enabled ? "ENABLED" : "OFF";
  indicator.classList.toggle("online", enabled);
  routing.textContent = enabled ? `Channel ${channel}` : "Disabled";
  port.textContent = enabled ? String(47176 + channel) : "--";
  automation.textContent = enabled ? "ON" : "OFF";
}

async function refresh() {
  try {
    const result = await tabMessage({ type: "GPTPS_GET_CHANNEL" });

    if (!result?.ok) throw new Error("Tab state unavailable");

    renderState(result);
  } catch (error) {
    status.textContent = String(error);
    indicator.textContent = "UNAVAILABLE";
    indicator.classList.remove("online");
  }
}

for (const button of buttons) {
  button.addEventListener("click", async () => {
    const channel = Number(button.dataset.gpChannel);

    for (const item of buttons) item.disabled = true;

    try {
      if (channel === 0) {
        const result = await tabMessage({
          type: "GPTPS_SET_ENABLED",
          enabled: false
        });

        if (!result?.ok) {
          throw new Error(result?.error || "Failed to disable tab");
        }
      } else {
        const choice = await tabMessage({
          type: "GPTPS_SET_CHANNEL",
          channel
        });

        if (!choice?.ok) {
          throw new Error(choice?.error || "Channel switch failed");
        }

        const enable = await tabMessage({
          type: "GPTPS_SET_ENABLED",
          enabled: true
        });

        if (!enable?.ok) {
          throw new Error(enable?.error || "Failed to enable tab");
        }
      }

      await refresh();
    } catch (error) {
      status.textContent = String(error);
    } finally {
      for (const item of buttons) item.disabled = false;
    }
  });
}

void updateBadge();
void refresh();
