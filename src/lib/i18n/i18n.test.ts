import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, dictionaries, format, matchAcceptLanguage } from "./index";

/** Liste à plat des clés d'un dictionnaire : "nav.items.dashboard" -> valeur */
function flatten(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const variables = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const reference = flatten(dictionaries.fr);

for (const locale of LOCALES) {
  test(`[${locale}] mêmes clés que le français`, () => {
    const keys = Object.keys(flatten(dictionaries[locale])).sort();
    assert.deepEqual(keys, Object.keys(reference).sort());
  });

  test(`[${locale}] mêmes variables {…} que le français`, () => {
    const flat = flatten(dictionaries[locale]);
    for (const [key, fr] of Object.entries(reference)) {
      assert.deepEqual(variables(flat[key]), variables(fr), `variables différentes pour « ${key} »`);
    }
  });

  test(`[${locale}] aucune traduction vide`, () => {
    for (const [key, value] of Object.entries(flatten(dictionaries[locale]))) {
      assert.ok(value.trim().length > 0, `« ${key} » est vide`);
    }
  });
}

test("format() remplace les variables et laisse les inconnues", () => {
  assert.equal(format("Il y a {n} min", { n: 5 }), "Il y a 5 min");
  assert.equal(format("{a} et {b}", { a: "x" }), "x et {b}");
});

test("matchAcceptLanguage choisit la première langue supportée", () => {
  assert.equal(matchAcceptLanguage("en-GB,en;q=0.9,fr;q=0.8"), "en");
  assert.equal(matchAcceptLanguage("de-DE,fr;q=0.8"), "fr");
  assert.equal(matchAcceptLanguage("de-DE,ja"), null);
  assert.equal(matchAcceptLanguage(null), null);
});
