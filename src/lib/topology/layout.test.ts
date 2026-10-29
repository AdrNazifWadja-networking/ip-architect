import { test } from "node:test";
import assert from "node:assert/strict";
import { bounds, layoutTopology, MAX_ROW, NODE_H, NODE_W, type LNode } from "./layout";

const n = (id: number, kind: LNode["kind"], x: number | null = null, y: number | null = null): LNode => ({ id, kind, x, y });

test("routeur en haut, switchs en dessous, bornes et machines en dessous encore", () => {
  const nodes = [n(1, "router"), n(2, "switch"), n(3, "switch"), n(4, "ap"), n(5, "host")];
  const l = layoutTopology(nodes, [{ aDevice: 1, bDevice: 2 }, { aDevice: 1, bDevice: 3 }, { aDevice: 2, bDevice: 4 }, { aDevice: 3, bDevice: 5 }]);
  const y = (id: number) => l.pos.get(id)!.y;
  assert.equal(y(1), 0);
  assert.equal(y(2), y(3));
  assert.ok(y(2) > y(1) && y(4) > y(2) && y(4) === y(5));
  // le routeur est centré au-dessus de ses deux switchs
  assert.equal(l.pos.get(1)!.x, (l.pos.get(2)!.x + l.pos.get(3)!.x) / 2);
});

test("aucune superposition ; déterministe ; composantes côte à côte ; équipement isolé placé", () => {
  const nodes = Array.from({ length: 30 }, (_, i) => n(i + 1, i === 0 ? "router" : i < 6 ? "switch" : "host"));
  const links = [...Array(5)].map((_, i) => ({ aDevice: 1, bDevice: i + 2 })).concat(Array.from({ length: 24 }, (_, i) => ({ aDevice: (i % 5) + 2, bDevice: i + 7 })));
  nodes.push(n(100, "switch"), n(101, "host")); // ilot
  links.push({ aDevice: 100, bDevice: 101 });
  nodes.push(n(200, "other")); // seul
  const a = layoutTopology(nodes, links), b = layoutTopology(nodes, links);
  assert.deepEqual([...a.pos], [...b.pos]);
  assert.equal(a.pos.size, nodes.length);
  const ps = [...a.pos.values()];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const overlap = Math.abs(ps[i].x - ps[j].x) < NODE_W && Math.abs(ps[i].y - ps[j].y) < NODE_H;
    assert.ok(!overlap, `superposition ${i}/${j}`);
  }
});

test("sans routeur : l'équipement le plus connecté sert de racine ; cycles et liens vers l'inconnu ignorés", () => {
  const nodes = [n(1, "switch"), n(2, "switch"), n(3, "switch"), n(4, "host")];
  const l = layoutTopology(nodes, [{ aDevice: 1, bDevice: 2 }, { aDevice: 2, bDevice: 3 }, { aDevice: 3, bDevice: 1 }, { aDevice: 2, bDevice: 4 }, { aDevice: 2, bDevice: 99 }, { aDevice: 3, bDevice: 3 }]);
  assert.equal(l.pos.get(2)!.y, 0); // degré 3
  assert.equal(l.pos.get(4)!.y, l.pos.get(1)!.y);
});

test("positions manuelles prioritaires ; cadrage ; graphe vide", () => {
  const l = layoutTopology([n(1, "router", 500, 300), n(2, "switch")], [{ aDevice: 1, bDevice: 2 }]);
  assert.deepEqual(l.pos.get(1), { x: 500, y: 300 });
  const b = bounds(l.pos);
  assert.ok(b.x < 500 && b.x + b.w > 500 + NODE_W);
  assert.deepEqual(layoutTopology([], []).pos.size, 0);
  assert.equal(bounds(new Map()).w, 600);
});

test("une rangée trop large est repliée en lignes équilibrées, sans superposition et centrée sous son parent", () => {
  const nodes = [n(1, "network"), ...Array.from({ length: 25 }, (_, i) => n(i + 2, "other"))];
  const links = Array.from({ length: 25 }, (_, i) => ({ aDevice: 1, bDevice: i + 2 }));
  const l = layoutTopology(nodes, links);
  const ys = [...new Set(nodes.slice(1).map((d) => l.pos.get(d.id)!.y))].sort((a, b) => a - b);
  assert.equal(ys.length, 4, "25 hôtes -> 4 lignes");
  const perLine = ys.map((y) => nodes.slice(1).filter((d) => l.pos.get(d.id)!.y === y).length);
  assert.deepEqual(perLine, [7, 7, 7, 4]);
  assert.ok(Math.max(...perLine) <= MAX_ROW);
  assert.ok(l.width <= MAX_ROW * (NODE_W + 40), "schéma beaucoup moins large qu'une seule rangée");
  const ps = [...l.pos.values()];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(!(Math.abs(ps[i].x - ps[j].x) < NODE_W && Math.abs(ps[i].y - ps[j].y) < NODE_H), `superposition ${i}/${j}`);
  // le parent est centré au-dessus de la plus large des lignes
  const first = nodes.slice(1).filter((d) => l.pos.get(d.id)!.y === ys[0]).map((d) => l.pos.get(d.id)!.x);
  assert.equal(l.pos.get(1)!.x, (Math.min(...first) + Math.max(...first)) / 2);
  // 8 hôtes ou moins : une seule ligne, comme avant
  const small = layoutTopology(nodes.slice(0, 9), links.slice(0, 8));
  assert.equal(new Set(nodes.slice(1, 9).map((d) => small.pos.get(d.id)!.y)).size, 1);
});
