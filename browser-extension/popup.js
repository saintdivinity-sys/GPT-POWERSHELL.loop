const toggle = document.getElementById("badgeToggle");
const stateLabel = document.getElementById("badgeState");

function render(visible) {
  toggle.classList.toggle("off", !visible);
  toggle.setAttribute("aria-pressed", String(visible));
  stateLabel.textContent = visible ? "Hide GPT↔PS badge" : "Show GPT↔PS badge";
}

async function load() {
  const result = await chrome.storage.local.get({ badgeVisible: true });
  render(result.badgeVisible !== false);
}

toggle.addEventListener("click", async () => {
  const result = await chrome.storage.local.get({ badgeVisible: true });
  const next = result.badgeVisible === false;
  await chrome.storage.local.set({ badgeVisible: next });
  render(next);
});

load();
