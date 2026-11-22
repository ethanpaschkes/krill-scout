// Merges the answer bank (tools/bank-src/*.json) into extension/data/topics.json, dropping anything risky:
// answers the crowd has made common in past dives, odd characters, duplicates. Run: node tools/build-topics.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "bank-src");
const OUT = path.join(__dirname, "../extension/data/topics.json");
const past = JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/data/krillion.json"), "utf8"));

const key = (a) => a.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^the /, "").replace(/[^a-z0-9]/g, "");
// Plankton or Schooler on any past prompt = the crowd already says it a lot.
const crowdSays = (a) => {
  const c = past.common[key(a)];
  return c && c[0] + c[1] > 0;
};
const clean = (a) => typeof a === "string" && a.length <= 40 && !/[()]/.test(a) && /^[\p{Script=Latin}0-9 '&.,!?:\/-]+$/u.test(a);

const topics = [];
let dropped = 0;
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".json")).sort()) {
  for (const t of JSON.parse(fs.readFileSync(path.join(SRC, file), "utf8"))) {
    const seen = new Set();
    const answers = [];
    for (const a of t.a || []) {
      const k = key(a);
      if (!clean(a) || !k || seen.has(k) || crowdSays(a)) {
        dropped++;
        continue;
      }
      seen.add(k);
      answers.push(a.trim());
    }
    if (answers.length && t.m?.length) topics.push({ t: t.t, m: t.m, a: answers });
  }
}
fs.writeFileSync(OUT, JSON.stringify(topics));
const total = topics.reduce((n, t) => n + t.a.length, 0);
console.log(`wrote ${topics.length} topics, ${total} answers (dropped ${dropped}), ${(fs.statSync(OUT).size / 1e3).toFixed(0)} KB`);
