// Krill Scout's own rarity model. No internet, no key.
// Krillion's FAQ says many prompts are ranked by "how often a word or name actually turns up in what people
// read and write". So the model scores every candidate by its real frequency in English text (the wordfreq
// data, ~313k words), turns that into a predicted tier, and re-learns the tier cut-offs from your own results.

const TIER_POINTS = { plankton: 10, tooclever: 15, schooler: 30, rare: 60, deepcut: 85, krillion: 100, miss: 0 };
const TIER_NAMES = {
  plankton: "Plankton", tooclever: "Too Clever", schooler: "Schooler",
  rare: "Rare", deepcut: "Deep Cut", krillion: "Krillion", miss: "Miss",
};

// Starting cut-offs on the Zipf scale (6 = "the", 3 = once per million words, 1 = once per billion).
// Learning replaces each centre with the median Zipf of your real answers in that tier.
const DEFAULT_CENTRES = { plankton: 4.7, schooler: 3.7, rare: 2.8, deepcut: 1.9 };

// The famously "obscure" picks everyone reaches for (the game's Too Clever trap). Your own Too Clever
// results are added to this list as you play.
const DEFAULT_TRAPS = [
  "antidisestablishmentarianism", "supercalifragilisticexpialidocious", "floccinaucinihilipilification",
  "pneumonoultramicroscopicsilicovolcanoconiosis", "hippopotomonstrosesquippedaliophobia", "ouagadougou",
  "ulaanbaatar", "ulan bator", "naypyidaw", "belmopan", "thimphu", "yamoussoukro", "llanfairpwllgwyngyll",
  "defenestration", "petrichor", "sesquipedalian", "onomatopoeia", "quixotic", "serendipity", "platypus",
  "axolotl", "aye-aye", "blobfish", "narwhal", "pangolin", "okapi", "quokka", "tardigrade", "mantis shrimp",
  "kakapo", "cassowary", "tuatara",
];

const NUMBER_WORDS = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”"]/g, "")
    .replace(/[’‘]/g, "'")
    .trim();
}

function lettersOnly(text) {
  return normalize(text).replace(/[^a-z]/g, "");
}

class KrillModel {
  constructor() {
    this.freq = new Map(); // word -> zipf
    this.dict = []; // [word, zipf] real dictionary words, most common first
    this.centres = { ...DEFAULT_CENTRES };
    this.traps = new Set(DEFAULT_TRAPS);
    this.history = [];
  }

  // `readText(name)` returns the contents of data/<name>; it differs between the extension and the tests.
  async load(readText) {
    const [freqText, dictText, krillionText] = await Promise.all([
      readText("freq.txt"),
      readText("dict.txt"),
      readText("krillion.json").catch(() => null),
    ]);
    if (krillionText) this.useKrillionData(JSON.parse(krillionText));
    const topicsText = await readText("topics.json").catch(() => null);
    if (topicsText) this.topics = JSON.parse(topicsText);
    for (const line of freqText.split("\n")) {
      const [cb, words] = line.split("\t");
      if (!words) continue;
      const zipf = 9 - Number(cb) / 100;
      for (const w of words.split(" ")) this.freq.set(w, zipf);
    }
    for (const line of dictText.split("\n")) {
      const [cb, words] = line.split("\t");
      if (!words) continue;
      const zipf = 9 - Number(cb) / 100;
      for (const w of words.split(" ")) this.dict.push([w, zipf]);
    }
  }

  // Zipf of a word or phrase. Phrases combine like wordfreq does: 1/f = sum of 1/f_i. 0 = never seen.
  zipf(text) {
    const tokens = normalize(text).split(/[^a-z0-9']+/).filter(Boolean);
    if (!tokens.length) return 0;
    let inv = 0;
    for (const t of tokens) {
      const z = this.freq.get(t);
      if (z === undefined) return 0;
      inv += 1 / 10 ** z;
    }
    return Math.round(Math.log10(1 / inv) * 100) / 100;
  }

  // Reads letter rules out of the prompt: containing "age", ending in "-ism", 5 letters, starting with B...
  parseRules(prompt) {
    const p = normalize(prompt);
    const rules = { contains: [], startsWith: null, endsWith: null, length: null, minLength: null, excludes: [] };
    const quoted = "[\"'“”‘’]?-?([a-z]+)-?[\"'“”‘’]?";
    for (const m of p.matchAll(new RegExp(`contain(?:s|ing)\\s+(?:the letters?\\s+)?${quoted}`, "g"))) rules.contains.push(m[1]);
    let m = p.match(new RegExp(`(?:ending|ends|that ends?)\\s+(?:in|with)\\s+(?:the letters?\\s+)?${quoted}`));
    if (m) rules.endsWith = m[1];
    m = p.match(new RegExp(`(?:starting|starts|beginning|begins|that starts?)\\s+with\\s+(?:the letters?\\s+|an?\\s+)?${quoted}`));
    if (m) rules.startsWith = m[1];
    m = p.match(/at least (\d+|[a-z]+) letters/);
    if (m) rules.minLength = Number(m[1]) || NUMBER_WORDS[m[1]] || null;
    m = p.match(/\b(\d+|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ -]letters?\b/);
    if (m && !rules.minLength) rules.length = Number(m[1]) || NUMBER_WORDS[m[1]];
    // 'with "and" in its name', 'has the letter B in its name', 'with both a U and an S in its name'.
    m = p.match(/\b(?:with|has|having) both (?:an? )?([a-z]) and (?:an? )?([a-z]) in (?:its|their|the) name/);
    if (m) rules.contains.push(m[1], m[2]);
    else {
      m = p.match(/\b(?:with|has|having) (?:the letters? |the word |an? )?([a-z]+) in (?:its|their|the) name/);
      if (m) rules.contains.push(m[1]);
    }
    for (const x of p.matchAll(/(?:without|no|not containing)\s+(?:the letter|an?)\s+[“"']?([a-z])\b/g)) rules.excludes.push(x[1]);
    const hasLetterRule = rules.contains.length || rules.startsWith || rules.endsWith || rules.length || rules.minLength;
    rules.wordPrompt = /\bword\b/.test(p) && Boolean(hasLetterRule);
    rules.promptWords = new Set(p.split(/[^a-z]+/).filter((w) => w.length > 2));
    return rules;
  }

  fits(answer, rules) {
    const w = lettersOnly(answer);
    if (!w) return false;
    if (rules.contains.some((c) => !w.includes(c))) return false;
    if (rules.startsWith && !w.startsWith(rules.startsWith)) return false;
    if (rules.endsWith && !w.endsWith(rules.endsWith)) return false;
    if (rules.length && w.length !== rules.length) return false;
    if (rules.minLength && w.length < rules.minLength) return false;
    if (rules.excludes.some((x) => w.includes(x))) return false;
    return true;
  }

  // For "Name an English word containing ough"-style prompts the model answers by itself from the dictionary.
  dictionaryCandidates(rules) {
    return this.dict.filter(([w]) => this.fits(w, rules)).map(([w]) => w);
  }

  // Past dives: the trained table, the crowd's common answers, and every past prompt with its gems.
  useKrillionData(data) {
    this.krillion = data;
  }

  // Chance of each tier, from what really happened to similar answers in past dives. Null without the data.
  tierChances(answer) {
    if (!this.krillion) return null;
    const { table, common } = this.krillion;
    const cls = seenClass(common[answerKey(answer)]);
    const rows = table[cls] || table.none;
    const row = rows[zipfBucket(this.zipf(answer))];
    const all = rows.all;
    const total = (r) => r.reduce((a, b) => a + b, 0);
    // Few examples in this exact cell? Lean on the whole class (backoff), so odd cells don't give silly numbers.
    const w = row ? total(row) / (total(row) + 20) : 0;
    const chances = {};
    TABLE_TIERS.forEach((t, i) => {
      chances[t] = w * ((row?.[i] ?? 0) / Math.max(1, total(row ?? []))) + (1 - w) * (all[i] / total(all));
    });
    return chances;
  }

  // The past prompt this one matches, if Krillion asked it before (exact) or something very close.
  matchPrompt(prompt) {
    if (!this.krillion) return null;
    const key = promptKey(prompt);
    const words = new Set(key.split(" "));
    let best = null;
    for (const p of this.krillion.prompts) {
      if (p.k === key) return { ...p, similarity: 1 };
      const other = p.k.split(" ");
      const shared = other.filter((w) => words.has(w)).length;
      const sim = shared / (words.size + other.length - shared);
      if (!best || sim > best.similarity) best = { ...p, similarity: sim };
    }
    return best;
  }

  // The answer-bank topic this prompt is about ("Name a European country" -> "European country"), picking the
  // most specific match. `extra` counts prompt words the topic doesn't cover ("...that no longer exists").
  matchTopic(prompt) {
    if (!this.topics) return null;
    const rules = this.parseRules(prompt);
    const hasLetterRule = rules.contains.length || rules.startsWith || rules.endsWith || rules.length || rules.minLength;
    const ignorable = (w) => FILLER.has(w) || (hasLetterRule && (RULE_WORDS.has(w) || w.length === 1 || /^\d+$/.test(w)));
    const words = new Set(promptKey(prompt).split(" "));
    let best = null;
    for (const topic of this.topics) {
      for (const phrase of topic.m) {
        const need = promptKey(phrase).split(" ").filter(Boolean);
        if (!need.length || !need.every((w) => words.has(w))) continue;
        const extra = [...words].filter((w) => !need.includes(w) && !ignorable(w)).length;
        if (!best || need.length > best.size) best = { ...topic, size: need.length, extra };
      }
    }
    return best;
  }

  predictTier(answer) {
    const key = normalize(answer);
    if (this.traps.has(key)) return "tooclever";
    const chances = this.tierChances(answer);
    if (chances) {
      // A gem is hand-picked, so the model only ever promises a Deep Cut.
      const { krillion, ...rest } = chances;
      rest.deepcut += krillion;
      return Object.entries(rest).sort((a, b) => b[1] - a[1])[0][0];
    }
    const z = this.zipf(answer);
    if (z === 0) return "deepcut";
    let best = "plankton";
    let bestGap = Infinity;
    for (const [tier, c] of Object.entries(this.centres)) {
      const gap = Math.abs(z - c);
      if (gap < bestGap) [best, bestGap] = [tier, gap];
    }
    return best;
  }

  // Chance the game accepts it. Unknown words may be real deep cuts or made up, so they are riskier.
  validity(answer, trusted) {
    const z = this.zipf(answer);
    const missRate = this.missRate(z);
    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    // Past dives show the rarest answers pay best (68% of never-written answers were Deep Cuts), so rarity is
    // only lightly penalised. Trusted = real dictionary words or the answer bank; AI ideas are fact-checked.
    const base = trusted
      ? clamp(0.82 + 0.04 * (z - 1), 0.82, 0.95)
      : z === 0 ? 0.7 : clamp(0.8 + 0.04 * (z - 1), 0.8, 0.93);
    const typo = this.looksLikeTypo(answer, z) ? 0.4 : 1;
    return (missRate === null ? base : (base + (1 - missRate)) / 2) * typo;
  }

  // "tought" is one letter from "thought", which is far more common, so it is probably a misspelling.
  // Only edits inside the word count: overage -> coverage (a new first letter) is a different real word.
  looksLikeTypo(answer, z) {
    const w = lettersOnly(answer);
    if (w.length < 4 || w.length !== normalize(answer).length) return false;
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const variants = [];
    for (let i = 1; i < w.length; i++) {
      variants.push(w.slice(0, i) + w.slice(i + 1));
      if (i < w.length - 1) variants.push(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
      for (const c of letters) variants.push(w.slice(0, i) + c + w.slice(i));
    }
    return variants.some((v) => v !== w && (this.freq.get(v) ?? 0) > z + 2.5);
  }

  missRate(z) {
    const near = this.history.filter((h) => Math.abs(h.zipf - z) < 0.5);
    if (near.length < 4) return null;
    return near.filter((h) => h.tier === "miss").length / near.length;
  }

  // "Ramen noodles" for "Name a noodle dish" -> "Ramen": drop a trailing plural of a prompt word.
  // Only plurals, so real names like "Mexico City" stay whole.
  trimEcho(answer, rules) {
    const words = answer.split(" ");
    const isPluralEcho = (w) => /s$/.test(w) && !rules.promptWords?.has(w) && (rules.promptWords?.has(w.slice(0, -1)) || rules.promptWords?.has(w.slice(0, -2)));
    while (words.length > 1 && isPluralEcho(normalize(words.at(-1)))) words.pop();
    return words.join(" ");
  }

  // Expected points = chance it counts x points for its predicted tier. Highest first.
  rank(candidates, rules, { trusted = false } = {}) {
    const seen = new Set();
    const scored = [];
    for (const raw of candidates) {
      // Trusted answers are already exact names ("Marshall Islands"), so only AI ideas get echo-trimmed.
      const tidy = raw.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
      const answer = trusted ? tidy : this.trimEcho(tidy, rules);
      const key = normalize(answer);
      if (!answer || answer.length > 40 || seen.has(key) || !this.fits(answer, rules)) continue;
      seen.add(key);
      const tier = this.predictTier(answer);
      const z = this.zipf(answer);
      const p = this.validity(answer, trusted);
      const chances = tier === "tooclever" ? null : this.tierChances(answer);
      const points = chances ? Object.entries(chances).reduce((sum, [t, c]) => sum + c * TIER_POINTS[t], 0) : TIER_POINTS[tier];
      const deep = chances ? chances.deepcut + chances.krillion : null;
      scored.push({ answer, tier, zipf: z, chance: p, deep, expected: p * points });
    }
    return scored.sort((a, b) => b.expected - a.expected || a.zipf - b.zipf);
  }

  rankDictionary(rules) {
    return this.rank(this.dictionaryCandidates(rules), rules, { trusted: true });
  }

  // Best `count` picks, skipping near-copies (forage / forages) so the picks are real alternatives.
  pickTop(ranked, count = 10) {
    const picks = [];
    for (const r of ranked) {
      const stem = lettersOnly(r.answer).slice(0, 5);
      if (picks.some((p) => lettersOnly(p.answer).slice(0, 5) === stem)) continue;
      picks.push(r);
      if (picks.length === count) break;
    }
    return picks;
  }

  // Your real result from the game: re-centre that tier and remember traps.
  learn({ answer, tier }) {
    const z = this.zipf(answer);
    this.history.push({ answer: normalize(answer), zipf: z, tier });
    if (tier === "tooclever") this.traps.add(normalize(answer));
    this.recentre();
  }

  setHistory(history) {
    this.history = history;
    for (const h of history) if (h.tier === "tooclever") this.traps.add(h.answer);
    this.recentre();
  }

  recentre() {
    for (const tier of Object.keys(DEFAULT_CENTRES)) {
      const zs = this.history.filter((h) => h.tier === tier && h.zipf > 0).map((h) => h.zipf);
      if (zs.length >= 3) this.centres[tier] = (median(zs) * zs.length + DEFAULT_CENTRES[tier] * 3) / (zs.length + 3);
    }
  }

  describe(pick) {
    if (pick.past) return pick.past;
    if (pick.deep !== null && pick.deep !== undefined) {
      return `${TIER_NAMES[pick.tier]} · ${Math.round(pick.deep * 100)}% deep · ${Math.round(pick.chance * 100)}% counts`;
    }
    const z = pick.zipf;
    const usage = z === 0 ? "almost never written" : `about 1 in ${formatOneIn(10 ** (9 - z))} words`;
    return `${TIER_NAMES[pick.tier]} likely · ${usage} · ${Math.round(pick.chance * 100)}% it counts`;
  }
}

// ---- Learning from past Krillion dives (data/krillion.json, built by tools/train.js) ----

const SEEN_TIERS = ["plankton", "schooler", "rare", "deepcut"];
const TABLE_TIERS = ["plankton", "schooler", "rare", "deepcut", "krillion"];
const STOP = new Set("name a an the any of that is are with or and in on for to its it be by from as one who which you".split(" "));

// "Name an animal whose name starts with K" -> "animal whose start k": what the prompt is about, word order ignored.
// Words that don't change what a prompt asks for ("Name a type of tea" = "Name a tea").
const FILLER = new Set("type kind sort famous popular well known real something thing example classic traditional common any".split(" "));
// Words that only state a letter rule, which fits() already enforces ("...whose name starts with S").
const RULE_WORDS = new Set("whose start begin end contain letter word long".split(" "));

function promptKey(prompt) {
  return [...new Set(normalize(prompt).replace(/[^a-z0-9+ ]/g, " ").split(/\s+/)
    .filter((w) => w && !STOP.has(w)).map((w) => w.replace(/(?<=.{3})(es|s)$/, "")))].sort().join(" ");
}

function answerKey(answer) {
  return normalize(answer).replace(/^the /, "").replace(/[^a-z0-9]/g, "");
}

// Rarity of a word in English text, in half-steps; 0 = not in the word list at all.
function zipfBucket(z) {
  return z === 0 ? "0" : String(Math.min(6, Math.max(1, Math.round(z * 2) / 2)));
}

// How common the crowd has made this answer on OTHER past prompts: the most common tier it reached, or "none".
function seenClass(counts, own) {
  if (!counts) return "none";
  for (let i = 0; i < SEEN_TIERS.length; i++) if (counts[i] - (own === i ? 1 : 0) > 0) return SEEN_TIERS[i];
  return "none";
}

// answer -> how many past prompts put it in Plankton / Schooler / Rare / Deep Cut.
function commonIndex(prompts) {
  const index = {};
  for (const p of prompts) {
    SEEN_TIERS.forEach((tier, i) => {
      for (const a of new Set(p[tier].map(answerKey))) (index[a] ||= [0, 0, 0, 0])[i]++;
    });
  }
  // Answers only ever seen once as a Deep Cut carry no signal for other prompts; drop them to keep the file small.
  for (const [k, c] of Object.entries(index)) if (c[0] + c[1] + c[2] === 0 && c[3] < 2) delete index[k];
  return index;
}

// The trained part: for every (seen-before class, word-rarity bucket), how often each real tier happened.
function buildTable(model, prompts) {
  const index = commonIndex(prompts);
  const table = {};
  for (const p of prompts) {
    TABLE_TIERS.forEach((tier) => {
      const own = SEEN_TIERS.indexOf(tier);
      const list = tier === "deepcut" && p.deepcut.length > 60 ? p.deepcut.filter((_, i) => i % Math.ceil(p.deepcut.length / 60) === 0) : p[tier];
      for (const a of list) {
        const cls = seenClass(index[answerKey(a)], own);
        for (const zb of [zipfBucket(model.zipf(a)), "all"]) {
          const row = ((table[cls] ||= {})[zb] ||= [0, 0, 0, 0, 0]);
          row[TABLE_TIERS.indexOf(tier)]++;
        }
      }
    });
  }
  return table;
}

function formatOneIn(n) {
  if (n >= 1e9) return `${Math.round(n / 1e9)} billion`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} million`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} thousand`;
  return String(Math.round(n));
}

if (typeof module !== "undefined") module.exports = { KrillModel, TIER_POINTS, TIER_NAMES, buildTable, commonIndex, promptKey };
