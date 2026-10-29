import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeOid, decodeResponse, encodeOid, encodeRequest, macOf, oidCompare, oidSuffix, oidUnder, SnmpError, TAG, vbIp, vbNumber, vbText } from "./codec";
import { SnmpClient } from "./client";
import { MibStore, ipv4, mac, num, serveUdp, str } from "./fakeAgent";

test("OID : encodage et décodage (vecteurs connus), ordre numérique, suffixes", () => {
  assert.equal(encodeOid("1.3.6.1.2.1.1.1.0").toString("hex"), "06082b060102010101" + "00");
  assert.equal(encodeOid("1.3.6.1.4.1.9.9.23.1.2.1.1.4").toString("hex"), "060d2b06010401090917010201010" + "4");
  for (const o of ["1.3.6.1.2.1.1.1.0", "1.0.8802.1.1.2.1.4.1.1.5.0.12.3", "2.100.3", "1.3.6.1.4.1.311.1.1.3.1.1"]) assert.equal(decodeOid(encodeOid(o).subarray(2)), o);
  assert.ok(oidCompare("1.3.6.1.2.1.2", "1.3.6.1.2.1.10") < 0); // numérique, pas alphabétique
  assert.ok(oidCompare("1.3.6.1", "1.3.6.1.0") < 0);
  assert.equal(oidCompare("1.3", "1.3"), 0);
  assert.ok(oidUnder("1.3.6.1.5", "1.3.6.1") && !oidUnder("1.3.6.1", "1.3.6.1") && !oidUnder("1.3.6.15", "1.3.6.1"));
  assert.deepEqual(oidSuffix("1.3.6.1.5.7", "1.3.6.1"), [5, 7]);
  assert.throws(() => encodeOid("1"), SnmpError);
  assert.throws(() => encodeOid("1.50.3"), SnmpError);
  assert.throws(() => encodeOid("1.a.3"), SnmpError);
});

test("requête GET « public » sysDescr : octets exacts (vecteur connu)", () => {
  const p = encodeRequest({ community: "public", requestId: 1, kind: "get", oids: ["1.3.6.1.2.1.1.1.0"] });
  assert.equal(p.toString("hex"), "30260201010406" + "7075626c6963" + "a019020101020100020100300e300c06082b060102010101000500");
  const b = encodeRequest({ community: "c", requestId: 7, kind: "getbulk", oids: ["1.3.6.1"], maxRepetitions: 25 });
  assert.equal(b[b.indexOf(TAG.GETBULK)], TAG.GETBULK);
});

test("valeurs : texte, nombre signé et non signé, IP, MAC", () => {
  assert.equal(vbText({ oid: "x", type: "str", value: Buffer.from("sw-01\0") }), "sw-01");
  assert.equal(vbText({ oid: "x", type: "str", value: Buffer.from([0xaa, 0x01, 0xbb, 0, 3, 4]) }), null);
  assert.equal(vbNumber({ oid: "x", type: "int", value: Buffer.from([0xff]) }), -1);
  assert.equal(vbNumber({ oid: "x", type: "uint", value: Buffer.from([0, 0xff, 0xff]) }), 65535);
  assert.equal(vbNumber({ oid: "x", type: "str", value: Buffer.from([1]) }), null);
  assert.equal(vbIp({ oid: "x", type: "ip", value: Buffer.from([10, 0, 0, 1]) }), "10.0.0.1");
  assert.equal(vbIp({ oid: "x", type: "str", value: Buffer.from([192, 168, 1, 9]) }), "192.168.1.9");
  assert.equal(macOf(Buffer.from([0xaa, 0xbb, 0xcc, 0, 1, 2])), "aa:bb:cc:00:01:02");
  assert.equal(macOf(Buffer.from([1, 2, 3])), null);
});

test("réponse : décodage et rejet des messages invalides", () => {
  assert.throws(() => decodeResponse(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01])), SnmpError);
  assert.throws(() => decodeResponse(Buffer.alloc(0)), SnmpError);
  assert.throws(() => decodeResponse(Buffer.from("garbage")), SnmpError);
});

const MIB = {
  "1.3.6.1.2.1.1.1.0": str("Switch de test"),
  "1.3.6.1.2.1.1.5.0": str("sw-test"),
  "1.3.6.1.2.1.2.2.1.2.1": str("Gi1/0/1"),
  "1.3.6.1.2.1.2.2.1.2.2": str("Gi1/0/2"),
  "1.3.6.1.2.1.2.2.1.2.10": str("Gi1/0/10"),
  "1.3.6.1.2.1.2.2.1.8.1": num(1),
  "1.3.6.1.2.1.4.20.1.1.10.0.0.5": ipv4("10.0.0.5"),
  "1.3.6.1.2.1.17.1.1.0": str(mac("aa:bb:cc:00:00:01")),
};

test("client SNMP sur un vrai socket UDP : get, walk (GETBULK) dans l'ordre numérique, plafond de lignes", async () => {
  const agent = await serveUdp(new MibStore(MIB), "public");
  try {
    const c = new SnmpClient({ host: "127.0.0.1", port: agent.port, community: "public", timeoutMs: 500, retries: 0 });
    const g = await c.get(["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.9.0"]);
    assert.equal(vbText(g[0]), "sw-test");
    assert.equal(g[1].type, "missing");
    const w = await c.walk("1.3.6.1.2.1.2.2.1.2");
    assert.deepEqual(w.map((v) => vbText(v)), ["Gi1/0/1", "Gi1/0/2", "Gi1/0/10"]); // 10 après 2 : ordre numérique
    assert.deepEqual((await c.walk("1.3.6.1.2.1.99")).length, 0);
    const small = new SnmpClient({ host: "127.0.0.1", port: agent.port, community: "public", maxRows: 2 });
    assert.equal((await small.walk("1.3.6.1.2.1.2.2.1")).length, 2);
    small.close();
    c.close();
  } finally {
    agent.close();
  }
});

test("client SNMP : mauvaise communauté = délai dépassé, hôte muet = délai dépassé, pas de crash", async () => {
  const agent = await serveUdp(new MibStore(MIB), "secret");
  try {
    const bad = new SnmpClient({ host: "127.0.0.1", port: agent.port, community: "public", timeoutMs: 150, retries: 1 });
    await assert.rejects(bad.get(["1.3.6.1.2.1.1.5.0"]), (e: unknown) => e instanceof SnmpError && e.kind === "timeout");
    bad.close();
  } finally {
    agent.close();
  }
  const mute = new SnmpClient({ host: "127.0.0.1", port: 9, community: "public", timeoutMs: 100, retries: 0 });
  await assert.rejects(mute.walk("1.3.6.1.2.1.1"), SnmpError);
  mute.close();
});
