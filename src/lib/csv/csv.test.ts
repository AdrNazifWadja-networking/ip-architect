import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv, detectDelimiter, formatCell, CsvError, BOM } from "./csv";

test("lecture : séparateur détecté, guillemets, sauts de ligne et guillemets doublés", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a,b,c"), ",");
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
  assert.equal(detectDelimiter('"a;b;c",d'), ",");
  assert.equal(detectDelimiter("seul"), ",");
  assert.deepEqual(parseCsv('a,b\n"x,1","dit ""oui"""\n"ligne1\nligne2",z'), [
    ["a", "b"],
    ["x,1", 'dit "oui"'],
    ["ligne1\nligne2", "z"],
  ]);
});

test("lecture : BOM, fins de ligne mixtes, lignes vides ignorées, dernière ligne sans saut", () => {
  assert.deepEqual(parseCsv(`${BOM}a;b\r\n1;2\r\n\r\n3;4\r5;6`), [["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\n\n"), []);
});

test("lecture : cellules vides conservées, espaces autour retirés (sauf entre guillemets)", () => {
  assert.deepEqual(parseCsv("a;;c\n; ;"), [["a", "", "c"], ["", "", ""]]);
  assert.deepEqual(parseCsv('  x  ;" y "'), [["x", " y "]]);
  assert.deepEqual(parseCsv('a;""\n'), [["a", ""]]);
});

test("lecture : guillemet non refermé -> CsvError avec la ligne d'ouverture", () => {
  assert.throws(() => parseCsv('a;b\nx;"oups\nsuite'), (e) => e instanceof CsvError && e.line === 2);
});

test("écriture : BOM, \\r\\n, guillemets seulement si nécessaire", () => {
  const out = toCsv(["a", "b"], [["x;y", 'dit "oui"'], ["multi\nligne", 5], [null, true]], ";");
  assert.ok(out.startsWith(BOM));
  assert.equal(out.slice(1), 'a;b\r\n"x;y";"dit ""oui"""\r\n"multi\nligne";5\r\n;true\r\n');
  assert.equal(formatCell("simple", ","), "simple");
  assert.equal(formatCell("a,b", ","), '"a,b"');
  assert.equal(formatCell("a,b", ";"), "a,b");
});

test("écriture : neutralisation des formules Excel, nombres négatifs intacts", () => {
  assert.equal(formatCell("=SOMME(A1)", ";"), "'=SOMME(A1)");
  assert.equal(formatCell("+33 1", ";"), "'+33 1");
  assert.equal(formatCell("@cmd", ";"), "'@cmd");
  assert.equal(formatCell("-x", ";"), "'-x");
  assert.equal(formatCell("-5", ";"), "-5");
  assert.equal(formatCell(-5, ";"), "-5");
  assert.equal(formatCell("normal", ";"), "normal");
});

test("aller-retour sans perte, quel que soit le séparateur", () => {
  const header = ["name", "note"];
  const rows = [
    ["=cmd|' /C calc'!A0", "+1"],
    ["'=déjà", "-x"],
    ["a;b,c\td", 'g"uil'],
    [" espace ", "ligne1\r\nligne2"],
    ["", "é à ç ✓"],
    ["'texte", "-12"],
  ];
  for (const d of [";", ",", "\t"] as const) {
    const back = parseCsv(toCsv(header, rows, d));
    assert.deepEqual(back, [header, ...rows], `séparateur ${JSON.stringify(d)}`);
  }
});
