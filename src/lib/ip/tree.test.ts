import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, type TreeInput, type TreeNode } from "./tree";

const net = (id: number, cidr: string, used = 0, capacity = 0): TreeInput => ({
  id, cidr, name: `n${id}`, version: cidr.includes(":") ? 6 : 4, status: "active", usedIps: used, capacity, tags: [],
});

test("arbre : /8 puis /16, un /16 reste sous son /8, un /24 sous /8 puis /16", () => {
  const t = buildTree([net(1, "10.1.1.0/24", 100, 254), net(2, "10.1.2.0/24", 50, 254), net(3, "10.2.0.0/16", 10, 65534), net(4, "192.168.0.0/24", 5, 254)]);
  assert.deepEqual(t.map((x) => x.cidr), ["10.0.0.0/8", "192.0.0.0/8"]);
  const ten = t[0];
  assert.deepEqual(ten.children.map((x) => `${x.kind}:${x.cidr}`), ["block:10.1.0.0/16", "network:10.2.0.0/16"]);
  assert.equal(ten.networkCount, 3);
  assert.equal(ten.used, 160);
  const sixteen = ten.children[0];
  assert.equal(sixteen.networkCount, 2);
  assert.deepEqual(sixteen.children.map((x) => x.cidr), ["10.1.1.0/24", "10.1.2.0/24"]);
  assert.equal(sixteen.used, 150);
  assert.equal(Math.round(sixteen.usagePct), 30);
});

test("arbre : part d'espace alloué par bloc, calculée en entiers (pas de dérive)", () => {
  const t = buildTree([net(1, "10.1.0.0/17"), net(2, "10.1.128.0/18")]);
  const b16 = t[0].children[0];
  assert.equal(b16.cidr, "10.1.0.0/16");
  assert.equal(b16.allocatedPct, 75);
  assert.equal(t[0].allocatedPct, Math.round((49152 / 16777216) * 10000) / 100);
});

test("arbre : un réseau de préfixe ≤ au niveau n'ouvre pas ce niveau ; /8 et plus grand = racine", () => {
  const t = buildTree([net(1, "10.0.0.0/8"), net(2, "172.16.0.0/12"), net(3, "0.0.0.0/0")]);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.cidr}`), ["network:0.0.0.0/0", "network:10.0.0.0/8", "block:172.0.0.0/8"]);
  const t2 = buildTree([net(1, "172.16.0.0/12"), net(2, "172.32.0.0/16")]);
  assert.deepEqual(t2[0].children.map((x) => `${x.kind}:${x.cidr}`), ["network:172.16.0.0/12", "network:172.32.0.0/16"]);
});

test("arbre : IPv6 regroupé en /32 puis /48, aucun compteur d'adresses", () => {
  const t = buildTree([net(1, "2001:db8:1::/64", 9, 99), net(2, "2001:db8:2::/48")]);
  assert.equal(t.length, 1);
  assert.equal(t[0].cidr, "2001:db8::/32");
  assert.equal(t[0].used, 0);
  const kinds = t[0].children.map((x: TreeNode) => `${x.kind}:${x.cidr}`);
  assert.deepEqual(kinds, ["block:2001:db8:1::/48", "network:2001:db8:2::/48"]);
});

test("arbre : IPv4 avant IPv6, ordre numérique, CIDR invalide ignoré", () => {
  const t = buildTree([net(1, "2001:db8::/32"), net(2, "9.0.0.0/24"), net(3, "10.0.0.0/24"), { ...net(4, "x"), cidr: "x" }]);
  assert.deepEqual(t.map((x) => x.cidr), ["9.0.0.0/8", "10.0.0.0/8", "2001:db8::/32"]);
});
