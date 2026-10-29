import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubnetConfig, checkVlsmConfig, cleanAnswers, generateSubnetQuestions, gradeSubnet, gradeVlsm, solveSubnet, vlsmSolution } from "./grade";
import type { VlsmConfig } from "./types";
import { calcSubnet, cidrContains } from "../ip/cidr";

const cfg: VlsmConfig = {
  parent: "192.168.10.0/24",
  needs: [
    { name: "Ventes", hosts: 100 }, // /25
    { name: "Compta", hosts: 50 }, // /26
    { name: "Wifi", hosts: 20 }, // /27
    { name: "Liaison", hosts: 2 }, // /30
  ],
};

test("vlsm : la solution de référence est valide, alignée et sans chevauchement", () => {
  const sol = vlsmSolution(cfg);
  assert.deepEqual(sol, ["192.168.10.0/25", "192.168.10.128/26", "192.168.10.192/27", "192.168.10.224/30"]);
  const r = gradeVlsm(cfg, Object.fromEntries(sol.map((c, i) => [String(i), c!])));
  assert.equal(r.score, 100);
  assert.ok(r.items.every((i) => i.code === "ok"));
});

test("vlsm : chaque défaut est détecté avec son code, et vaut zéro (ou la moitié si trop grand)", () => {
  const a = {
    "0": "192.168.10.0/25", // ok
    "1": "192.168.10.64/26", // chevauche le besoin 0
    "2": "10.0.0.0/27", // hors du bloc
    "3": "192.168.10.225/30", // pas une adresse réseau
  };
  const r = gradeVlsm(cfg, a);
  assert.deepEqual(r.items.map((i) => i.code), ["overlap", "overlap", "outside", "notNetwork"]);
  assert.equal(r.score, 0);

  const b = gradeVlsm(cfg, { "0": "192.168.10.0/26", "1": "192.168.10.128/25", "2": "192.168.10.64/27", "3": "" });
  assert.deepEqual(b.items.map((i) => i.code), ["tooSmall", "oversized", "ok", "missing"]);
  assert.equal(b.items[1].points, 12.5);
  assert.deepEqual(b.items[1].params, { got: 25, best: 26 });
  assert.equal(b.score, Math.round(12.5 + 25));

  assert.equal(gradeVlsm(cfg, { "0": "n'importe quoi", "1": "2001:db8::/64" }).items[0].code, "invalid");
  assert.equal(gradeVlsm(cfg, { "1": "2001:db8::/64" }).items[1].code, "invalid", "IPv6 refusé");
  // même réponse deux fois = chevauchement des deux
  assert.deepEqual(gradeVlsm(cfg, { "0": "192.168.10.0/25", "1": "192.168.10.0/25" }).items.slice(0, 2).map((i) => i.code), ["overlap", "overlap"]);
});

test("vlsm : la bonne réponse n'est incluse que si on le demande (jamais envoyée à un étudiant par défaut)", () => {
  assert.equal(gradeVlsm(cfg, {}, true).items[0].expected, "192.168.10.0/25");
  assert.equal(gradeVlsm(cfg, {}, false).items[0].expected, undefined);
});

test("vlsm : validation de la configuration", () => {
  assert.equal(checkVlsmConfig(cfg).ok, true);
  const code = (raw: unknown) => { const r = checkVlsmConfig(raw); return r.ok ? "ok" : r.code; };
  assert.equal(code(null), "tpParentInvalid");
  assert.equal(code({ parent: "10.0.0.5/24", needs: cfg.needs }), "tpParentInvalid", "pas une adresse réseau");
  assert.equal(code({ parent: "2001:db8::/48", needs: cfg.needs }), "tpParentInvalid", "IPv4 seulement");
  assert.equal(code({ parent: "10.0.0.0/31", needs: cfg.needs }), "tpParentInvalid");
  assert.equal(code({ parent: "10.0.0.0/24", needs: [] }), "tpNeedsInvalid");
  assert.equal(code({ parent: "10.0.0.0/24", needs: [{ name: "A", hosts: 0 }] }), "tpNeedsInvalid");
  assert.equal(code({ parent: "10.0.0.0/24", needs: [{ name: "A", hosts: 1.5 }] }), "tpNeedsInvalid");
  assert.equal(code({ parent: "10.0.0.0/24", needs: [{ name: "", hosts: 5 }] }), "tpNeedsInvalid");
  assert.equal(code({ parent: "10.0.0.0/24", needs: [{ name: "A", hosts: 5 }, { name: "a", hosts: 5 }] }), "tpNeedsInvalid", "noms uniques sans tenir compte de la casse");
  assert.equal(code({ parent: "10.0.0.0/24", needs: [{ name: "A", hosts: 200 }, { name: "B", hosts: 200 }] }), "tpUnsolvable");
  assert.equal(code({ parent: "10.0.0.0/24", needs: Array.from({ length: 13 }, (_, i) => ({ name: `n${i}`, hosts: 1 })) }), "tpNeedsInvalid");
});

test("sous-réseau : questions déterministes par graine, distinctes entre étudiants, toujours valides", () => {
  const a = generateSubnetQuestions("7:42", 8);
  assert.deepEqual(a, generateSubnetQuestions("7:42", 8), "même graine, mêmes questions");
  assert.notDeepEqual(a.map((q) => q.cidr), generateSubnetQuestions("7:43", 8).map((q) => q.cidr));
  assert.equal(a.length, 8);
  assert.deepEqual(a.map((q) => q.key), ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]);
  assert.equal(new Set(a.map((q) => calcSubnet(q.cidr)!.cidr)).size, 8, "pas deux fois le même sous-réseau");
  for (const seed of ["1:1", "2:9", "3:77", "x"]) {
    for (const q of generateSubnetQuestions(seed, 20)) {
      const s = calcSubnet(q.cidr)!;
      const p = Number(q.cidr.split("/")[1]);
      assert.ok(p >= 20 && p <= 30, q.cidr);
      assert.notEqual(q.cidr.split("/")[0], s.network, "l'adresse posée est un hôte, pas l'adresse réseau");
      assert.notEqual(q.cidr.split("/")[0], s.broadcast);
      assert.ok(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((r) => cidrContains(r, s.cidr)), `privée : ${q.cidr}`);
    }
  }
});

test("sous-réseau : solution de référence cohérente avec le calculateur, notation et formes de réponse acceptées", () => {
  const sol = solveSubnet("192.168.37.141/27")!;
  assert.deepEqual(sol, { network: "192.168.37.128", broadcast: "192.168.37.159", firstHost: "192.168.37.129", lastHost: "192.168.37.158", hosts: "30", mask: "255.255.255.224" });
  const q = [{ key: "q1", cidr: "192.168.37.141/27" }];
  const fields = ["network", "broadcast", "firstHost", "lastHost", "hosts", "mask"] as const;
  const full = gradeSubnet(q, [...fields], { q1: { network: " 192.168.37.128 ", broadcast: "192.168.037.159", firstHost: "192.168.37.129", lastHost: "192.168.37.158", hosts: "30", mask: "/27" } });
  assert.equal(full.items.find((i) => i.field === "broadcast")!.code, "wrong", "zéro initial : adresse non canonique, parseIp décide");
  const ok = gradeSubnet(q, [...fields], { q1: { network: " 192.168.37.128 ", broadcast: "192.168.37.159", firstHost: "192.168.37.129", lastHost: "192.168.37.158", hosts: " 30 ", mask: "/27" } });
  assert.equal(ok.score, 100);
  assert.equal(gradeSubnet(q, ["mask"], { q1: { mask: "27" } }).score, 100);
  assert.equal(gradeSubnet(q, ["mask"], { q1: { mask: "255.255.255.224" } }).score, 100);
  assert.equal(gradeSubnet(q, ["mask"], { q1: { mask: "255.255.255.192" } }).items[0].code, "wrong");
  // mauvaise réponse sur un champ : note proportionnelle, bonne réponse masquée si on le demande
  const part = gradeSubnet(q, ["network", "hosts"], { q1: { network: "192.168.37.128", hosts: "32" } }, false);
  assert.equal(part.score, 50);
  assert.deepEqual(part.items.map((i) => i.code), ["ok", "wrong"]);
  assert.equal(part.items[1].expected, undefined);
  assert.equal(gradeSubnet(q, ["network"], {}).items[0].code, "missing");
  assert.equal(gradeSubnet(q, ["hosts"], { q1: { hosts: "abc" } }).items[0].code, "wrong");
  assert.equal(gradeSubnet(q, ["hosts"], { q1: { hosts: "99999999999999999999" } }).items[0].code, "wrong", "pas de dépassement");
});

test("sous-réseau : validation de la configuration", () => {
  const ok = checkSubnetConfig({ count: 4, fields: ["hosts", "network"] });
  assert.deepEqual(ok, { ok: true, config: { count: 4, fields: ["network", "hosts"] } }, "ordre canonique");
  assert.deepEqual(checkSubnetConfig({}), { ok: true, config: { count: 5, fields: ["network", "broadcast", "firstHost", "lastHost", "hosts"] } });
  for (const bad of [null, { count: 0 }, { count: 21 }, { count: 2.5 }, { fields: [] }, { fields: ["nope"] }, { fields: ["network", "network"] }, { fields: "network" }]) {
    assert.deepEqual(checkSubnetConfig(bad), { ok: false, code: "tpSubnetConfigInvalid" }, JSON.stringify(bad));
  }
});

test("réponses reçues : nettoyées, bornées, formes invalides refusées", () => {
  assert.deepEqual(cleanAnswers("vlsm", { "0": " 10.0.0.0/24\n", "1": 5 }), { "0": "10.0.0.0/24", "1": "" });
  assert.equal(cleanAnswers("vlsm", [1]), null);
  assert.equal(cleanAnswers("vlsm", "x"), null);
  assert.equal(cleanAnswers("vlsm", { "../x": "a" }), null);
  assert.equal((cleanAnswers("vlsm", { "0": "x".repeat(500) })!["0"] as string).length, 100);
  assert.deepEqual(cleanAnswers("subnet", { q1: { network: "1.2.3.0", evil: "x" } }), { q1: { network: "1.2.3.0" } });
  assert.equal(cleanAnswers("subnet", { q1: "x" }), null);
});
