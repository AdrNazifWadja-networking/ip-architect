import { test } from "node:test";
import assert from "node:assert/strict";
import { crawl, kindFromCaps, readDevice } from "./discover";
import { MibStore, ipv4, mac, num, str } from "../snmp/fakeAgent";
import type { SnmpLike } from "../snmp/client";

type E = ReturnType<typeof str>;
interface Nb { lp: number; chassis: string; port: string; name: string; ip?: string; caps?: number }

function device(o: { name: string; chassis: string; services: number; ports: string[]; nbs?: Nb[]; fdb?: [string, number][]; arp?: [string, string][]; descr?: string }): MibStore {
  const m: Record<string, E> = {
    "1.3.6.1.2.1.1.1.0": str(o.descr ?? `${o.name} descr`), "1.3.6.1.2.1.1.5.0": str(o.name), "1.3.6.1.2.1.1.7.0": num(o.services),
    "1.0.8802.1.1.2.1.3.2.0": str(mac(o.chassis)),
  };
  o.ports.forEach((p, i) => {
    m[`1.3.6.1.2.1.31.1.1.1.1.${i + 1}`] = str(p); m[`1.3.6.1.2.1.2.2.1.3.${i + 1}`] = num(6);
    m[`1.3.6.1.2.1.2.2.1.8.${i + 1}`] = num(1); m[`1.3.6.1.2.1.31.1.1.1.15.${i + 1}`] = num(1000);
    m[`1.3.6.1.2.1.17.1.4.1.2.${i + 1}`] = num(i + 1);
  });
  (o.nbs ?? []).forEach((n, i) => {
    const k = `0.${n.lp}.${i + 1}`;
    m[`1.0.8802.1.1.2.1.4.1.1.5.${k}`] = str(mac(n.chassis)); m[`1.0.8802.1.1.2.1.4.1.1.8.${k}`] = str(n.port);
    m[`1.0.8802.1.1.2.1.4.1.1.9.${k}`] = str(n.name); m[`1.0.8802.1.1.2.1.4.1.1.12.${k}`] = str(Buffer.from([n.caps ?? 0x28, 0]));
    if (n.ip) m[`1.0.8802.1.1.2.1.4.2.1.3.${k}.1.4.${n.ip}`] = num(1);
  });
  for (const [mc, port] of o.fdb ?? []) m[`1.3.6.1.2.1.17.7.1.2.2.1.2.1.${mc.split(":").map((x) => parseInt(x, 16)).join(".")}`] = num(port);
  for (const [mc, ip] of o.arp ?? []) m[`1.3.6.1.2.1.4.22.1.2.1.${ip}`] = str(mac(mc));
  return new MibStore(m);
}

const CORE = "aa:00:00:00:00:01", SW = "aa:00:00:00:00:02", AP = "aa:00:00:00:00:03", PC = "bb:00:00:00:00:09";
const fleet = (): Record<string, MibStore> => ({
  "10.0.0.1": device({ name: "core", chassis: CORE, services: 6, ports: ["eth0", "eth1"], nbs: [{ lp: 1, chassis: SW, port: "Gi1/0/24", name: "sw1", ip: "10.0.0.2", caps: 0x20 }], arp: [[PC, "10.0.0.50"]], descr: "pfSense firewall" }),
  "10.0.0.2": device({ name: "sw1", chassis: SW, services: 2, ports: ["Gi1/0/1", "Gi1/0/2", "Gi1/0/24"], nbs: [{ lp: 3, chassis: CORE, port: "eth0", name: "core", ip: "10.0.0.1", caps: 0x08 }, { lp: 2, chassis: AP, port: "eth0", name: "ap1", caps: 0x10 }], fdb: [[PC, 1], [AP, 2], [CORE, 3]] }),
});
const deps = (f: Record<string, MibStore>) => ({ connect: (a: string): SnmpLike => { const d = f[a]; if (!d) throw new Error("injoignable"); return d; } });

test("kindFromCaps : bits LLDP et pare-feu reconnu par sa description", () => {
  assert.equal(kindFromCaps(Buffer.from([0x10]), null), "ap");
  assert.equal(kindFromCaps(Buffer.from([0x28]), null), "switch");
  assert.equal(kindFromCaps(Buffer.from([0x08]), null), "router");
  assert.equal(kindFromCaps(Buffer.from([0x04]), null), "phone");
  assert.equal(kindFromCaps(null, "FortiGate 60F"), "firewall");
  assert.equal(kindFromCaps(null, null), null);
});

test("readDevice : identité, ports, voisins LLDP, machines (FDB) sans les ports de liaison", async () => {
  const r = await readDevice(fleet()["10.0.0.2"]);
  assert.equal(r.name, "sw1");
  assert.equal(r.kind, "switch");
  assert.equal(r.chassisId, SW);
  assert.deepEqual(r.ports.map((p) => p.name), ["Gi1/0/1", "Gi1/0/2", "Gi1/0/24"]);
  assert.equal(r.ports[0].speedMbps, 1000);
  assert.deepEqual(r.neighbors.map((n) => [n.localPort, n.name, n.remotePort]).sort(), [["Gi1/0/2", "ap1", "eth0"], ["Gi1/0/24", "core", "eth0"]]);
  // le PC est un client du port 1 ; l'AP (port 2) et le routeur (port 3) sont des voisins : pas des clients
  assert.deepEqual(r.clients.map((c) => [c.port, c.mac]), [["Gi1/0/1", PC]]);
  assert.equal(r.clients[0].vlan, 1);
});

test("crawl : découvre switch et AP depuis le routeur, fusionne le lien annoncé des deux côtés, ajoute l'IP du client via ARP", async () => {
  const res = await crawl("10.0.0.1", 3, deps(fleet()));
  assert.deepEqual(res.devices.map((d) => [d.name, d.kind, d.polled]).sort(), [["ap1", "ap", false], ["core", "firewall", true], ["sw1", "switch", true]]);
  assert.equal(res.links.length, 2); // core–sw1 (une seule fois), sw1–ap1
  const cs = res.links.find((l) => res.devices.find((d) => d.key === l.a)!.name === "core" || res.devices.find((d) => d.key === l.b)!.name === "core")!;
  assert.equal(cs.speedMbps, 1000);
  assert.equal(res.clients.length, 1);
  assert.deepEqual([res.clients[0].mac, res.clients[0].ip, res.clients[0].port], [PC, "10.0.0.50", "Gi1/0/1"]);
});

test("crawl : profondeur 0 = seulement le départ ; injoignable et refusé = notes, pas d'exception ; annulation", async () => {
  const f = fleet();
  const r0 = await crawl("10.0.0.1", 0, deps(f));
  assert.equal(r0.devices.filter((d) => d.polled).length, 1);
  assert.equal(r0.devices.length, 2); // le voisin est connu, pas interrogé
  const bad = await crawl("10.9.9.9", 2, deps(f));
  assert.equal(bad.devices.length, 0);
  assert.match(bad.notes[0], /injoignable/);
  const ref = await crawl("10.0.0.1", 3, { ...deps(f), refuse: (a) => (a === "10.0.0.2" ? "adresse refusée" : null) });
  assert.ok(ref.notes.some((n) => n.includes("refusée")));
  const ac = new AbortController(); ac.abort();
  assert.equal((await crawl("10.0.0.1", 3, { ...deps(f), signal: ac.signal })).cancelled, true);
});

test("crawl : plafond de 200 équipements", async () => {
  const nbs: Nb[] = Array.from({ length: 250 }, (_, i) => ({ lp: 1, chassis: `cc:00:00:00:${(i >> 8).toString(16).padStart(2, "0")}:${(i & 255).toString(16).padStart(2, "0")}`, port: "p", name: `n${i}` }));
  const f = { "10.0.0.1": device({ name: "big", chassis: CORE, services: 6, ports: ["e"], nbs }) };
  const r = await crawl("10.0.0.1", 2, deps(f));
  assert.equal(r.devices.length, 200);
  assert.ok(r.notes.includes("limit"));
});
