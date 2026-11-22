const AI_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};
const TIER_NAMES = { krillion: "Krillion", deepcut: "Deep Cut", rare: "Rare", schooler: "Schooler", tooclever: "Too Clever", plankton: "Plankton", miss: "Miss" };

const aiEl = document.getElementById("ai");
const setupEl = document.getElementById("setup");
const autoEl = document.getElementById("auto");

async function showAiState() {
  if (typeof LanguageModel === "undefined") {
    aiEl.textContent = "Not in this Chrome. Update Chrome (version 138 or newer). Word prompts still work.";
    return;
  }
  const state = await LanguageModel.availability(AI_OPTIONS);
  setupEl.hidden = state !== "downloadable";
  aiEl.textContent = {
    available: "Ready ✓",
    downloadable: "Needs a one-time download (about 2 GB, free).",
    downloading: "Downloading… keep Chrome open.",
    unavailable: "This computer can't run it (needs about 22 GB free disk and 16 GB memory or a good graphics chip). Word prompts still work.",
  }[state] || state;
}

// The download has to start from a click, so it lives here.
setupEl.addEventListener("click", async () => {
  setupEl.disabled = true;
  try {
    const session = await LanguageModel.create({
      ...AI_OPTIONS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => (aiEl.textContent = `Downloading… ${Math.round(e.loaded * 100)}%`));
      },
    });
    session.destroy();
  } catch (e) {
    aiEl.textContent = `Download failed: ${e.message}`;
  }
  setupEl.disabled = false;
  showAiState();
});

async function showStats() {
  const { history = [] } = await chrome.storage.local.get("history");
  if (!history.length) return;
  const counts = {};
  for (const h of history) counts[h.tier] = (counts[h.tier] || 0) + 1;
  document.getElementById("stats").textContent =
    `${history.length} answers: ` +
    Object.keys(TIER_NAMES).filter((t) => counts[t]).map((t) => `${counts[t]} ${TIER_NAMES[t]}`).join(", ");
  const reset = document.getElementById("reset");
  reset.hidden = false;
  reset.onclick = async () => {
    await chrome.storage.local.remove("history");
    location.reload();
  };
}

// Cheat code: only its SHA-256 fingerprint is stored here, so reading the source doesn't give the code away.
const CODE_HASH = "c17bb5a95380538d39761f02f232e0d0fa43453315cdd2f04cc8eba3c9d9e1a4";
const codeMsg = document.getElementById("codeMsg");
const deepEl = document.getElementById("deep");

async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function showUnlocked(on) {
  document.getElementById("deepRow").hidden = false;
  document.getElementById("codeForm").hidden = true;
  codeMsg.hidden = false;
  codeMsg.className = "ok";
  codeMsg.textContent = "Deep Dive unlocked 🔱";
  deepEl.checked = on;
}

document.getElementById("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ((await sha256(code)) === CODE_HASH) {
    await chrome.storage.local.set({ deepUnlocked: true, deepMode: true });
    showUnlocked(true);
  } else {
    codeMsg.hidden = false;
    codeMsg.className = "";
    codeMsg.textContent = "Nope. That's not it.";
  }
});
deepEl.addEventListener("change", () => chrome.storage.local.set({ deepMode: deepEl.checked }));
chrome.storage.local.get(["deepUnlocked", "deepMode"]).then((s) => s.deepUnlocked && showUnlocked(s.deepMode === true));

chrome.storage.local.get("autoType").then(({ autoType }) => (autoEl.checked = autoType !== false));
autoEl.addEventListener("change", () => chrome.storage.local.set({ autoType: autoEl.checked }));

showAiState();
showStats();
