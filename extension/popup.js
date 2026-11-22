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

chrome.storage.local.get("autoType").then(({ autoType }) => (autoEl.checked = autoType !== false));
autoEl.addEventListener("change", () => chrome.storage.local.set({ autoType: autoEl.checked }));

showAiState();
showStats();
