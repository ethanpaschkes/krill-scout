// Tests for the public build. Run: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { KrillModel } = require("../extension/model.js");

const EXT = path.join(__dirname, "../extension");
const ready = (async () => {
  const m = new KrillModel();
  await m.load(async (name) => fs.readFileSync(path.join(EXT, "data", name), "utf8"));
  return m;
})();

test("10 rare dictionary picks for letter prompts", async () => {
  const m = await ready;
  const rules = m.parseRules("Name an English word containing “ough”");
  const picks = m.pickTop(m.rankDictionary(rules));
  assert.strictEqual(picks.length, 10);
  for (const p of picks) assert.ok(m.fits(p.answer, rules), p.answer);
});

test("answer bank answers topic prompts instantly", async () => {
  const m = await ready;
  const topic = m.matchTopic("Name a car brand");
  assert.strictEqual(topic.extra, 0);
  assert.ok(topic.a.length >= 10);
  assert.ok(m.matchTopic("Name an Italian painter").extra > 0);
});

test("answers the crowd always gives rank low", async () => {
  const m = await ready;
  const ranked = m.rank(["Toyota", "Moskvitch"], m.parseRules("Name a car brand"), { trusted: true });
  assert.strictEqual(ranked[0].answer, "Moskvitch");
});

test("the public build carries no autoplay and no past-answer lists", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.flatMap((c) => c.js);
  if (fs.existsSync(path.join(EXT, "autoplay.js"))) return; // the personal build: nothing to check
  assert.ok(!scripts.includes("autoplay.js"));
  const data = JSON.parse(fs.readFileSync(path.join(EXT, "data/krillion.json"), "utf8"));
  assert.strictEqual(data.prompts.length, 0);
});

test("reads 'X in its name' rules", async () => {
  const m = await ready;
  const and = m.parseRules('Name a country with "and" in its name');
  assert.ok(!m.fits("Palau", and));
  assert.ok(m.fits("Saint Kitts and Nevis", and));
  assert.deepStrictEqual(m.parseRules("Name a country with both a U and an S in its name").contains, ["u", "s"]);
});
