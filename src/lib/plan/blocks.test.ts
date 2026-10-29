import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateBlocks, cidrBlock, freeBlocks, prefixForHosts, rangeToCidrs, summarize, supernet, usableHosts } from "./blocks";
import { cidrOverlap } from "../ip/cidr";

test("rangeToCidrs : plage quelconque -> plus petit ensemble de CIDR", () => {
  const b = cidrBlock("10.0.0.5/32")!;
  assert.deepEqual(rangeToCidrs(4, b.start, b.end), ["10.0.0.5/32"]);
  const lo = cidrBlock("10.0.0.1/32")!;
  const hi = cidrBlock("10.0.0.6/32")!;
  assert.deepEqual(rangeToCidrs(4, lo.start, hi.end), ["10.0.0.1/32", "10.0.0.2/31", "10.0.0.4/31", "10.0.0.6/32"]);
  const all = cidrBlock("0.0.0.0/0")!;
  assert.deepEqual(rangeToCidrs(4, all.start, all.end), ["0.0.0.0/0"]);
  const v6 = cidrBlock("2001:db8::/32")!;
  assert.deepEqual(rangeToCidrs(6, v6.start, v6.end), ["2001:db8::/32"]);
});

test("summarize : fusion de voisins alignés, chevauchements, doublons, versions séparées", () => {
  assert.deepEqual(summarize(["10.0.0.0/25", "10.0.0.128/25"]), ["10.0.0.0/24"]);
  assert.deepEqual(summarize(["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]), ["10.0.0.0/22"]);
  assert.deepEqual(summarize(["10.0.0.0/24", "10.0.0.0/24", "10.0.0.64/26"]), ["10.0.0.0/24"]);
  // non alignés : 10.0.1.0/24 + 10.0.2.0/24 ne forment pas un /23
  assert.deepEqual(summarize(["10.0.1.0/24", "10.0.2.0/24"]), ["10.0.1.0/24", "10.0.2.0/24"]);
  assert.deepEqual(summarize(["192.168.0.0/24", "2001:db8::/64", "2001:db8:0:1::/64"]), ["192.168.0.0/24", "2001:db8::/63"]);
  assert.deepEqual(summarize(["pas un cidr"]), []);
});

test("supernet : plus petit CIDR contenant tout", () => {
  assert.equal(supernet(["10.0.0.0/24", "10.0.3.0/24"]), "10.0.0.0/22");
  assert.equal(supernet(["10.0.1.0/24", "10.0.2.0/24"]), "10.0.0.0/22");
  assert.equal(supernet(["10.1.2.3/32"]), "10.1.2.3/32");
  assert.equal(supernet(["10.0.0.0/8", "192.168.0.0/16"]), "0.0.0.0/0");
  assert.equal(supernet(["10.0.0.0/24", "2001:db8::/64"]), null, "versions mélangées");
  assert.equal(supernet([]), null);
});

test("freeBlocks : parent moins plages occupées", () => {
  assert.deepEqual(freeBlocks("10.0.0.0/24", []), ["10.0.0.0/24"]);
  assert.deepEqual(freeBlocks("10.0.0.0/24", ["10.0.0.0/25"]), ["10.0.0.128/25"]);
  assert.deepEqual(freeBlocks("10.0.0.0/24", ["10.0.0.64/26"]), ["10.0.0.0/26", "10.0.0.128/25"]);
  assert.deepEqual(freeBlocks("10.0.0.0/24", ["10.0.0.0/24"]), []);
  assert.deepEqual(freeBlocks("10.0.0.0/24", ["10.0.0.0/16"]), [], "occupé par un réseau plus grand");
  assert.deepEqual(freeBlocks("10.0.0.0/24", ["192.168.0.0/24", "2001:db8::/64"]), ["10.0.0.0/24"], "hors parent / autre version");
  // la somme libre + occupé = parent
  const free = freeBlocks("10.0.0.0/22", ["10.0.1.0/24", "10.0.3.128/25"]);
  const size = (c: string) => 2 ** (32 - Number(c.split("/")[1]));
  assert.equal(free.reduce((a, c) => a + size(c), 0), 1024 - 256 - 128);
});

test("prefixForHosts / usableHosts", () => {
  assert.equal(prefixForHosts(1), 30);
  assert.equal(prefixForHosts(2), 30);
  assert.equal(prefixForHosts(3), 29);
  assert.equal(prefixForHosts(6), 29);
  assert.equal(prefixForHosts(7), 28);
  assert.equal(prefixForHosts(254), 24);
  assert.equal(prefixForHosts(255), 23);
  assert.equal(prefixForHosts(0), null);
  assert.equal(prefixForHosts(1.5), null);
  assert.equal(usableHosts(4, 24), 254n);
  assert.equal(usableHosts(4, 31), 2n);
  assert.equal(usableHosts(4, 32), 1n);
  assert.equal(usableHosts(6, 64), 1n << 64n);
});

test("allocateBlocks : VLSM, plus gros d'abord, résultat dans l'ordre d'entrée, sans chevauchement", () => {
  const req = [
    { key: "a", prefix: 26 }, // 64
    { key: "b", prefix: 24 }, // 256
    { key: "c", prefix: 30 },
    { key: "d", prefix: 25 }, // 128
  ];
  const r = allocateBlocks("10.0.0.0/23", [], req);
  assert.deepEqual(r.map((x) => x.key), ["a", "b", "c", "d"]);
  assert.equal(r.find((x) => x.key === "b")!.cidr, "10.0.0.0/24");
  assert.equal(r.find((x) => x.key === "d")!.cidr, "10.0.1.0/25");
  assert.equal(r.find((x) => x.key === "a")!.cidr, "10.0.1.128/26");
  assert.equal(r.find((x) => x.key === "c")!.cidr, "10.0.1.192/30");
  const cidrs = r.map((x) => x.cidr!);
  for (let i = 0; i < cidrs.length; i++) for (let j = i + 1; j < cidrs.length; j++) assert.ok(!cidrOverlap(cidrs[i], cidrs[j]));
});

test("allocateBlocks : évite les réseaux existants, signale manque de place et bloc trop grand", () => {
  const taken = ["10.0.0.0/25", "10.0.0.192/26"];
  const r = allocateBlocks("10.0.0.0/24", taken, [
    { key: 1, prefix: 26 }, // seul trou : 10.0.0.128/26
    { key: 2, prefix: 26 }, // plus de place
    { key: 3, prefix: 16 }, // plus grand que le parent
  ]);
  assert.equal(r[0].cidr, "10.0.0.128/26");
  assert.deepEqual([r[1].cidr, r[1].reason], [null, "noSpace"]);
  assert.deepEqual([r[2].cidr, r[2].reason], [null, "tooBig"]);
  // un réseau existant dans un trou ne déplace pas les autres : alignement respecté
  const r2 = allocateBlocks("10.0.0.0/24", ["10.0.0.0/26"], [{ key: "x", prefix: 25 }]);
  assert.equal(r2[0].cidr, "10.0.0.128/25");
});

test("allocateBlocks : IPv6 et même préfixe = ordre d'entrée conservé", () => {
  const r = allocateBlocks("2001:db8::/48", [], [
    { key: 1, prefix: 64 },
    { key: 2, prefix: 64 },
  ]);
  assert.deepEqual(r.map((x) => x.cidr), ["2001:db8::/64", "2001:db8:0:1::/64"]);
});

test("allocateBlocks : exhaustivité — remplir exactement un /24 avec 4 x /26", () => {
  const r = allocateBlocks("10.9.9.0/24", [], [1, 2, 3, 4, 5].map((k) => ({ key: k, prefix: 26 })));
  assert.deepEqual(r.map((x) => x.cidr), ["10.9.9.0/26", "10.9.9.64/26", "10.9.9.128/26", "10.9.9.192/26", null]);
});

test("allocateBlocks : test aléatoire (graine fixe) contre une recherche naïve", () => {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    // parent 10.0.0.0/22 (1024 adresses) ; occupé et demandes aléatoires, en blocs de 16 à 256
    const taken: string[] = [];
    for (let i = rnd(4); i > 0; i--) {
      const prefix = 24 + rnd(5); // /24../28
      const size = 2 ** (32 - prefix);
      const slot = rnd(1024 / size) * size;
      taken.push(`10.0.${Math.floor(slot / 256)}.${slot % 256}/${prefix}`);
    }
    const reqs = Array.from({ length: 1 + rnd(6) }, (_, i) => ({ key: i, prefix: 24 + rnd(5) }));
    const res = allocateBlocks("10.0.0.0/22", taken, reqs);

    const occupied = new Uint8Array(1024);
    const mark = (cidr: string) => {
      const b = cidrBlock(cidr)!;
      const off = Number(b.start - cidrBlock("10.0.0.0/22")!.start);
      for (let i = 0; i < Number(b.end - b.start + 1n); i++) occupied[off + i] = 1;
    };
    taken.forEach(mark);
    const free = (off: number, size: number) => {
      for (let i = 0; i < size; i++) if (occupied[off + i]) return false;
      return true;
    };
    // on rejoue dans l'ordre « plus gros d'abord » : mêmes décisions que l'allocateur
    const order = reqs.map((_, i) => i).sort((a, b) => reqs[a].prefix - reqs[b].prefix || a - b);
    for (const i of order) {
      const size = 2 ** (32 - reqs[i].prefix);
      let expected: number | null = null;
      for (let off = 0; off < 1024; off += size) if (free(off, size)) { expected = off; break; }
      if (expected === null) {
        assert.equal(res[i].cidr, null, `round ${round} req ${i}`);
        assert.equal(res[i].reason, "noSpace");
      } else {
        assert.equal(res[i].cidr, `10.0.${Math.floor(expected / 256)}.${expected % 256}/${reqs[i].prefix}`, `round ${round} req ${i}`);
        mark(res[i].cidr!);
      }
    }
  }
});
