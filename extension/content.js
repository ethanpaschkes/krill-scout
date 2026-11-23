// Watches krillion.io for a new prompt, shows 5 picks from Krill Scout's own model, and types the best one in.
// Word prompts ("containing ough") are answered from the built-in dictionary; category prompts ("a noodle
// dish") get ideas from Chrome's free on-device AI (Gemini Nano), then the model ranks them by rarity.
// It never presses DIVE: you check the pick and submit it yourself.

const PROMPT_SELECTOR = ".prompt, .kr-prompt"; // krillion.io, playdaily.org/krillion
const INPUT_SELECTOR = 'input[aria-label="Your answer"]';
const AI_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};
const AI_SYSTEM =
  "You are an expert at obscure trivia. Give short answers only (1-4 words), no explanations. " +
  "Every answer must be real, correctly spelled and truly fit the prompt. Use the common English name.";
const AI_SCHEMA = { type: "object", properties: { answers: { type: "array", items: { type: "string" } } }, required: ["answers"] };

const model = new KrillModel();
const modelReady = model
  .load((name) => fetch(chrome.runtime.getURL(`data/${name}`)).then((r) => r.text()))
  .then(() => chrome.storage.local.get("history"))
  .then(({ history = [] }) => model.setHistory(history));

let aiSession = null;
let lastPrompt = "";
let panel;

// Creating the AI session takes ~20 s the first time, so start it as soon as the page opens.
function warmUpAi() {
  if (aiSession || typeof LanguageModel === "undefined") return aiSession;
  aiSession = LanguageModel.availability(AI_OPTIONS).then((state) =>
    state === "available" ? LanguageModel.create({ ...AI_OPTIONS, initialPrompts: [{ role: "system", content: AI_SYSTEM }] }) : null
  ).then(async (session) => {
    // A tiny practice question loads the AI into memory now, so the first real prompt doesn't wait for it.
    if (session) {
      const practice = await session.clone();
      await practice.prompt("Name a fruit. One word.").catch(() => {});
      practice.destroy();
    }
    return session;
  }).catch(() => null);
  return aiSession;
}

// One question to a fresh copy of the session, so earlier prompts don't steer it.
async function askOnce(text, schema, signal) {
  const session = await (await warmUpAi()).clone({ signal });
  try {
    return JSON.parse(await session.prompt(text, { responseConstraint: schema, signal }));
  } finally {
    session.destroy();
  }
}

// Streams one list of obscure answers and calls onIdea for each one the moment it is complete, so picks can
// show after 2-3 s instead of waiting for the whole list.
async function streamIdeas(prompt, onIdea, signal) {
  const session = await (await warmUpAi()).clone({ signal });
  try {
    const text =
      `Task: ${prompt}.\nList 15 correct answers that almost nobody would think of: real but obscure, old, ` +
      `regional or niche. Skip the famous ones everyone says first. Each one must exactly fit the task.`;
    let full = "";
    let sent = 0;
    for await (const chunk of session.promptStreaming(text, { responseConstraint: AI_SCHEMA, signal })) {
      full += chunk;
      // Every finished string in the JSON so far, except the "answers" key itself.
      const done = [...full.matchAll(/"((?:[^"\\]|\\.)*)"\s*(?=[,\]])/g)].map((m) => m[1]);
      // Skip garbled output (mixed scripts like "Kinhாளா"): Krillion answers are in Latin letters.
      while (sent < done.length) {
        const idea = done[sent++];
        if (/^[\p{Script=Latin}0-9 '&.,!?-]+$/u.test(idea)) onIdea(idea);
      }
    }
  } finally {
    session.destroy();
  }
}

// Fact-check the ideas in one quick pass: the small on-device AI sometimes slips in things that don't fit.
async function factCheck(prompt, ideas, signal) {
  const check = await askOnce(
    `Task: "${prompt}". For each item, does it truly and exactly fit the task? Answer true or false for each, in order.\n` +
      ideas.map((x, i) => `${i + 1}. ${x}`).join("\n"),
    { type: "object", properties: { fits: { type: "array", items: { type: "boolean" } } }, required: ["fits"] },
    signal
  );
  return ideas.filter((_, i) => check.fits[i] === true);
}

// Krillion asked this exact prompt in a past daily dive: its real One in a Krillion answers first, then real Deep Cuts.
function pastPicks(past, rules) {
  const gems = past.gem.map((gem) => ({ answer: gem.replace(/\s*\(.*?\)\s*/g, " ").trim(), tier: "krillion", past: "One in a Krillion last time" }));
  const deep = model.rank(past.deep, rules).map((p) => ({ ...p, tier: "deepcut", deep: 1, past: "Deep Cut last time" }));
  return model.pickTop([...gems, ...deep]);
}

function ensurePanel() {
  if (panel?.isConnected) return panel;
  panel = document.createElement("div");
  panel.id = "krill-scout";
  panel.innerHTML = `<div class="ks-head">🦐 Krill Scout</div><div class="ks-body"></div>`;
  document.body.appendChild(panel);
  return panel;
}

function setBody(html) {
  ensurePanel().querySelector(".ks-body").innerHTML = html;
}

// The game is a React app, so a plain `input.value = x` is ignored.
// Setting the value through the native setter and firing "input" makes React see it.
// Types the answer in lowercase, one letter at a time like a person, so the game sees real typing.
// A newer call cancels one still typing.
const TYPE_DELAY_MS = 18;
let typing = 0;

async function typeIntoBox(text) {
  const input = document.querySelector(INPUT_SELECTOR);
  if (!input) return false;
  const job = ++typing;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  input.focus();
  setValue.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  let typed = "";
  for (const ch of text.toLowerCase()) {
    if (job !== typing) return false;
    typed += ch;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    setValue.call(input, typed);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
  }
  return job === typing;
}

// The prompt shows during a ~3 s countdown, before the answer box exists, so wait for the box.
function waitForInput(timeoutMs = 30000) {
  const found = document.querySelector(INPUT_SELECTOR);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const input = document.querySelector(INPUT_SELECTOR);
      if (input) finish(input);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(input) {
      observer.disconnect();
      clearTimeout(timer);
      resolve(input);
    }
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

let currentPicks = [];
let typedByUs = ""; // what Krill Scout last put in the box, so it never overwrites your own typing
let picksFinal = false;
let autoSend = false; // when another script sends answers itself, it types them too, so auto-type stays out of its way

function showPicks(picks, source) {
  currentPicks = picks;
  setBody(
    picks
      .map(
        (p, i) =>
          `<button class="ks-pick" data-answer="${escapeHtml(p.answer)}"><b>${i + 1}. ${escapeHtml(p.answer)}</b>` +
          `<span class="ks-tier ks-${p.tier}">${escapeHtml(model.describe(p))}</span></button>`
      )
      .join("") + `<div class="ks-hint">${escapeHtml(source)} · keys 1-9 and 0 (=10) or click to use a pick</div>`
  );
  ensurePanel()
    .querySelectorAll(".ks-pick")
    .forEach((btn) => btn.addEventListener("click", () => fill(btn.dataset.answer)));
}

async function fill(answer) {
  typedByUs = answer.toLowerCase();
  return typeIntoBox(answer);
}

// Auto-type the best pick, and keep it up to date as better picks arrive, unless you've typed something yourself.
async function autoFill(prompt, answer) {
  const { autoType = true } = await chrome.storage.local.get("autoType");
  if (!autoType) return;
  const input = await waitForInput();
  if (input && prompt === lastPrompt && answer === currentPicks[0]?.answer && (!input.value || input.value === typedByUs) && !autoSend) fill(answer);
}

// Shows picks (and auto-types the best) for a prompt, unless the game has already moved on.
// `final` = good enough to submit: no better picks are coming, or the top ones are already sure answers.
function update(prompt, picks, source, final = true) {
  if (prompt !== lastPrompt || !picks.length) return;
  picksFinal = final;
  showPicks(picks, source);
  autoFill(prompt, picks[0].answer);
}

const PICKS = 10;

// Deep Dive mode (switch in the 🦐 menu): only picks the model rates as likely Deep Cuts.
// On 40 dives it never saw, picks rated 45%+ were real Deep Cuts about twice as often as average, 70%+ about 3x.
const DEEP_MIN = 0.45;
let deepMode = false;
const readDeepMode = () => chrome.storage.local.get("deepMode").then((s) => (deepMode = s.deepMode === true));
readDeepMode();
chrome.storage.onChanged?.addListener((c) => c.deepMode && readDeepMode());

// The final 10 from a ranked list. In Deep Dive mode: only likely Deep Cuts, the most likely first.
function finish(ranked) {
  if (!deepMode) return model.pickTop(ranked, PICKS);
  const deepness = (r) => (r.tier === "krillion" ? 2 : r.deep ?? 0);
  return model.pickTop(ranked.filter((r) => deepness(r) >= DEEP_MIN).sort((a, b) => deepness(b) - deepness(a)), PICKS);
}

// Ranks two lists together: `sure` answers (answer bank, past dives) and `maybe` ones (AI ideas, loose matches).
function best(sure, maybe, rules) {
  const ranked = [...model.rank(sure, rules, { trusted: true }), ...model.rank(maybe, rules)];
  const seen = new Set();
  return finish(ranked.sort((a, b) => b.expected - a.expected).filter((r) => !seen.has(r.answer.toLowerCase()) && seen.add(r.answer.toLowerCase())));
}

async function getPicks(prompt, signal) {
  await modelReady;
  const rules = model.parseRules(prompt);
  const past = model.matchPrompt(prompt);
  // A past daily prompt: its real winners lead the list; anything short of 10 is topped up below.
  const lead = past?.similarity === 1 ? pastPicks(past, rules) : [];
  const show = (picks, source, final) => {
    // Skip near-copies of the leading answers too ("Sao Tome" next to "Sao Tome and Principe").
    const stem = (p) => p.answer.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
    const taken = new Set(lead.map(stem));
    const list = [...lead, ...picks.filter((p) => !taken.has(stem(p)))].slice(0, PICKS);
    if (!list.length && final && deepMode && prompt === lastPrompt) {
      return setBody(`<div class="ks-error">No likely Deep Cuts for this one. Turn off Deep Dive in the 🦐 menu for more picks.</div>`);
    }
    update(prompt, list, deepMode ? `🔱 Deep Dive · ${source}` : source, final);
  };
  if (lead.length) {
    show([], "from a past Krillion dive", true);
    if (lead.length >= PICKS) return;
  }
  if (rules.wordPrompt) return show(finish(model.rankDictionary(rules)), "from the dictionary", true);

  // Instant: the answer bank (~360 topics) and close past prompts. `sure` = the topic covers the whole prompt.
  const topic = model.matchTopic(prompt);
  const banked = topic ? topic.a.filter((a) => model.fits(a, rules)) : [];
  const sure = topic?.extra === 0 ? banked : [];
  const maybe = topic && topic.extra > 0 && topic.size > topic.extra ? banked.slice(0, 15) : [];
  if (past && past.similarity >= 0.6) maybe.push(...past.deep.filter((a) => model.fits(a, rules)));
  const enough = sure.length >= PICKS;
  if (sure.length || maybe.length) {
    show(best(sure, maybe, rules), sure.length ? `from the answer bank (${topic.t})` : "quick guesses · checking…", enough || sure.length >= 3 || lead.length > 0);
  }
  if (enough) return;

  // Not enough sure answers: Chrome AI tops the list up, streaming ideas in as it thinks, then fact-checks them.
  if (!(await warmUpAi())) {
    if (!currentPicks.length) setBody(`<div class="ks-error">Chrome's built-in AI isn't ready. Open the 🦐 menu to set it up.</div>`);
    picksFinal = true;
    return;
  }
  const ideas = [];
  await streamIdeas(
    prompt,
    (idea) => {
      ideas.push(idea);
      show(best(sure, [...maybe, ...ideas], rules), "Chrome AI is adding ideas…", sure.length >= 3 || lead.length > 0);
    },
    signal
  );
  const checked = await factCheck(prompt, [...new Set([...maybe, ...ideas])], signal);
  // Fact-checked picks first; if fewer than 10 survive, the unchecked ones fill the bottom of the list.
  const top = best(sure, checked, rules);
  const named = new Set(top.map((p) => p.answer.toLowerCase()));
  const rest = best(sure, [...maybe, ...ideas], rules).filter((p) => !named.has(p.answer.toLowerCase()));
  show([...top, ...rest].slice(0, PICKS), "fact-checked · ranked on 896 past prompts", true);
}

// The AI work for the previous prompt, cancelled as soon as the game moves on so it can't hold up the new one.
let aiWork = null;

async function onNewPrompt(prompt) {
  aiWork?.abort();
  aiWork = new AbortController();
  currentPicks = [];
  picksFinal = false;
  typedByUs = "";
  setBody(`<div class="ks-hint">Thinking about “${escapeHtml(prompt)}”…</div>`);
  try {
    await getPicks(prompt, aiWork.signal);
  } catch (e) {
    if (e.name !== "AbortError" && prompt === lastPrompt && !currentPicks.length) setBody(`<div class="ks-error">Couldn't get picks: ${escapeHtml(e.message)}</div>`);
  }
}

// Press 1-9 (or 0 for the 10th) to put that pick in the box. Ignored once you've started typing your own answer.
window.addEventListener(
  "keydown",
  (e) => {
    const n = e.key === "0" ? 10 : Number(e.key);
    if (!e.isTrusted || !(n >= 1 && n <= 10) || e.ctrlKey || e.metaKey || e.altKey || !currentPicks[n - 1]) return;
    const input = document.querySelector(INPUT_SELECTOR);
    if (!input) return;
    const own = input.value && input.value !== typedByUs && !currentPicks.some((p) => p.answer.toLowerCase() === input.value);
    if (own) return;
    e.preventDefault();
    e.stopPropagation();
    fill(currentPicks[n - 1].answer);
  },
  true
);

// Your real result for each answer you submit (see results.js) teaches the model.
window.addEventListener("message", async (event) => {
  const result = event.source === window && event.data?.krillScoutResult;
  if (!result?.answer || !result.tier) return;
  await modelReady;
  model.learn(result);
  const { history = [] } = await chrome.storage.local.get("history");
  history.push(model.history.at(-1));
  await chrome.storage.local.set({ history: history.slice(-2000) });
});


function check() {
  const prompt = document.querySelector(PROMPT_SELECTOR)?.innerText.trim();
  if (!prompt || prompt === lastPrompt) return;
  lastPrompt = prompt;
  onNewPrompt(prompt);
}

warmUpAi();
new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
check();
