import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import {
  applyCrawl, applyScanHosts, cancelDiscovery, createCredential, createDevice, createLink, deleteCredential, deleteDevice, deleteLink, discoveryStatus, getTopology, listClients,
  listCredentials, setPositions, startDiscovery, topoAddressRefused, updateCredential, updateDevice,
} from "./topology";
import { MibStore, mac, num, str } from "../snmp/fakeAgent";
import type { SnmpLike } from "../snmp/client";
import { createNetwork, getActiveProject } from "./queries";
import { ApiError } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}
const code = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { if (e instanceof ApiError) return e.code; throw e; }
};

test("adresses : seules les IPv4 privées sont interrogeables", () => {
  assert.equal(topoAddressRefused("192.168.1.1", {}), false);
  assert.equal(topoAddressRefused("10.2.3.4", {}), false);
  assert.equal(topoAddressRefused("8.8.8.8", {}), true);
  assert.equal(topoAddressRefused("8.8.8.8", { IP_ARCHITECT_SCAN_PUBLIC: "1" }), false);
  assert.equal(topoAddressRefused("fd00::1", {}), true);
  assert.equal(topoAddressRefused("pas-une-ip", {}), true);
});

test("identifiants SNMP : la communauté n'est jamais renvoyée ; mise à jour sans la changer ; doublon ; suppression", () => {
  const db = freshDb();
  const c = createCredential({ name: "Parc", community: "s3cret" }, db);
  assert.deepEqual(c, { id: c.id, name: "Parc", port: 161 });
  assert.ok(!JSON.stringify(listCredentials(db)).includes("s3cret"));
  assert.equal(code(() => createCredential({ name: "Parc", community: "x" }, db)), "topoDuplicate");
  assert.equal(code(() => createCredential({ name: "", community: "x" }, db)), "topoInvalid");
  assert.equal(code(() => createCredential({ name: "B", community: "" }, db)), "topoInvalid");
  updateCredential(c.id, { name: "Parc2" }, db);
  assert.equal((db.prepare("SELECT community FROM snmp_credentials WHERE id = ?").get(c.id) as { community: string }).community, "s3cret");
  updateCredential(c.id, { community: "neuf" }, db);
  assert.equal((db.prepare("SELECT community FROM snmp_credentials WHERE id = ?").get(c.id) as { community: string }).community, "neuf");
  assert.equal(code(() => updateCredential(999, { name: "z" }, db)), "topoCredentialNotFound");
  for (let i = 0; i < 19; i++) createCredential({ name: `c${i}`, community: "x" }, db);
  assert.equal(code(() => createCredential({ name: "trop", community: "x" }, db)), "topoCredentialLimit");
  deleteCredential(c.id, db);
  assert.equal(code(() => deleteCredential(c.id, db)), "topoCredentialNotFound");
});

test("équipements et liens manuels : validation, lien unique, suppression en cascade, positions", () => {
  const db = freshDb();
  const a = createDevice({ name: "Routeur", kind: "router", address: "10.0.0.1" }, db);
  const b = createDevice({ name: "Switch", kind: "switch" }, db);
  assert.equal(code(() => createDevice({ name: "x", kind: "frigo" }, db)), "topoInvalid");
  assert.equal(code(() => createDevice({ name: "x", address: "pas-une-ip" }, db)), "topoInvalid");
  assert.equal(code(() => createDevice({ name: "x", siteId: 9999 }, db)), "topoInvalid");
  const l = createLink({ aDevice: b.id, aPort: "Gi1", bDevice: a.id, bPort: "eth0" }, db);
  assert.ok(l.aDevice < l.bDevice);
  assert.equal(l.aPort, l.aDevice === b.id ? "Gi1" : "eth0"); // les ports suivent leur équipement
  assert.equal(code(() => createLink({ aDevice: a.id, aPort: "eth0", bDevice: b.id, bPort: "Gi1" }, db)), "topoInvalidLink"); // même lien, autre sens
  assert.equal(code(() => createLink({ aDevice: a.id, bDevice: a.id }, db)), "topoInvalidLink");
  assert.equal(code(() => createLink({ aDevice: a.id, bDevice: 999 }, db)), "topoDeviceNotFound");
  assert.equal(updateDevice(a.id, { name: "Cœur", x: 10, y: 20 }, db).x, 10);
  assert.equal(code(() => updateDevice(a.id, { x: null, y: 5 }, db)), "topoInvalid"); // une seule coordonnée
  assert.equal(setPositions({ positions: [{ id: a.id, x: 1, y: 2 }, { id: 999, x: 1, y: 2 }] }, db), 1);
  assert.equal(setPositions({ reset: true }, db), 2);
  assert.equal(getTopology(db).devices.find((d) => d.id === a.id)!.x, null);
  deleteDevice(b.id, db);
  assert.equal(getTopology(db).links.length, 0);
  assert.equal(code(() => deleteLink(l.id, db)), "topoLinkNotFound");
});

test("applyCrawl : crée, fusionne avec le manuel sans l'écraser, remplace les liens périmés, ne touche pas aux liens manuels", () => {
  const db = freshDb();
  const manual = createDevice({ name: "Mon routeur", kind: "firewall", address: "10.0.0.1" }, db);
  const res = (extra = true) => ({
    devices: [
      { key: "d1", name: "core", address: "10.0.0.1", kind: "router" as const, info: "descr", chassisId: "aa:00:00:00:00:01", polled: true, ports: [{ name: "eth0", speedMbps: 1000, up: true }] },
      { key: "d2", name: "sw1", address: "10.0.0.2", kind: "switch" as const, info: null, chassisId: "aa:00:00:00:00:02", polled: true, ports: [] },
      ...(extra ? [{ key: "d3", name: "ap1", address: null, kind: "ap" as const, info: null, chassisId: "aa:00:00:00:00:03", polled: false, ports: [] }] : []),
    ],
    links: [
      { a: "d1", aPort: "eth0", b: "d2", bPort: "Gi24", via: "lldp" as const, speedMbps: 1000, reportedBy: "d1" },
      ...(extra ? [{ a: "d2", aPort: "Gi2", b: "d3", bPort: "eth0", via: "lldp" as const, speedMbps: null, reportedBy: "d2" }] : []),
    ],
    clients: [{ device: "d2", port: "Gi1", mac: "bb:00:00:00:00:09", ip: "10.0.0.50", vlan: 1 }],
    notes: [], cancelled: false,
  });
  const r1 = applyCrawl(db, 1, res(), null);
  assert.deepEqual([r1.devices, r1.links, r1.clients], [3, 2, 1]);
  let t = getTopology(db);
  assert.equal(t.devices.length, 3); // le routeur saisi à la main (même adresse) est fusionné, pas dupliqué
  const core = t.devices.find((d) => d.id === manual.id)!;
  assert.equal(core.name, "Mon routeur"); // nom et type manuels conservés
  assert.equal(core.kind, "firewall");
  assert.equal(core.chassisId, "aa:00:00:00:00:01");
  assert.equal(t.devices.find((d) => d.name === "ap1")!.source, "lldp");
  assert.equal(listClients(t.devices.find((d) => d.name === "sw1")!.id, db)[0].ip, "10.0.0.50");
  // lien manuel : survit à une nouvelle découverte
  const ap = t.devices.find((d) => d.name === "ap1")!, core2 = core;
  createLink({ aDevice: core2.id, aPort: "eth1", bDevice: ap.id, bPort: "x" }, db);
  // 2e découverte : l'AP et le lien sw1–ap1 ont disparu, plus de client
  applyCrawl(db, 1, { ...res(false), clients: [] }, null);
  t = getTopology(db);
  assert.equal(t.links.filter((l) => l.source !== "manual").length, 1);
  assert.equal(t.links.filter((l) => l.source === "manual").length, 1);
  assert.equal(listClients(t.devices.find((d) => d.name === "sw1")!.id, db).length, 0);
  assert.equal(t.devices.length, 3); // l'AP n'est pas supprimé tout seul (l'utilisateur décide)
  // relancer la même découverte ne duplique rien
  applyCrawl(db, 1, res(false), null);
  assert.equal(getTopology(db).links.filter((l) => l.source !== "manual").length, 1);
});

const fleetStore = (): MibStore => new MibStore({
  "1.3.6.1.2.1.1.1.0": str("solo"), "1.3.6.1.2.1.1.5.0": str("solo"), "1.3.6.1.2.1.1.7.0": num(6), "1.0.8802.1.1.2.1.3.2.0": str(mac("aa:00:00:00:00:77")),
});

test("découverte : refus d'adresse publique, identifiants inconnus, une seule à la fois, résultat enregistré, communauté transmise à la connexion", async () => {
  const db = freshDb();
  const c = createCredential({ name: "Parc", community: "s3cret" }, db);
  assert.equal(code(() => startDiscovery({ seed: "8.8.8.8", credentialId: c.id }, db)), "topoAddressRefused");
  assert.equal(code(() => startDiscovery({ seed: "10.0.0.1", credentialId: 999 }, db)), "topoCredentialNotFound");
  assert.equal(code(() => startDiscovery({ seed: "10.0.0.1" }, db)), "topoInvalid");
  const seen: string[] = [];
  const { finished } = startDiscovery({ seed: "10.0.0.1", credentialId: c.id }, db, { connect: (a, comm) => { seen.push(`${a}/${comm}`); return fleetStore(); } });
  assert.equal(code(() => startDiscovery({ seed: "10.0.0.1", credentialId: c.id }, db)), "topoBusy");
  assert.equal(discoveryStatus().status, "running");
  await finished;
  assert.deepEqual(seen, ["10.0.0.1/s3cret"]);
  assert.equal(discoveryStatus().status, "done");
  assert.equal(getTopology(db).devices.length, 1);
  assert.equal(getTopology(db).devices[0].source, "snmp");
  assert.equal(getTopology(db).devices[0].credentialId, c.id);
  assert.ok(!JSON.stringify(discoveryStatus()).includes("s3cret"));
});

test("découverte : équipement injoignable = terminée avec note ; annulation", async () => {
  const db = freshDb();
  const c = createCredential({ name: "Parc", community: "x" }, db);
  const r = startDiscovery({ seed: "10.0.0.9", credentialId: c.id }, db, { connect: () => { throw new Error("aucune réponse"); } });
  await r.finished;
  assert.equal(discoveryStatus().status, "done");
  assert.match(discoveryStatus().notes[0], /aucune réponse/);
  assert.equal(cancelDiscovery(), false);
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const slow = { get: async () => { await gate; return []; }, walk: async () => [], close() {} };
  const r2 = startDiscovery({ seed: "10.0.0.9", credentialId: c.id }, db, { connect: () => slow });
  assert.equal(cancelDiscovery(), true);
  release();
  await r2.finished;
  assert.ok(["cancelled", "done"].includes(discoveryStatus().status));
});

test("découverte d'un réseau de l'IPAM : hôtes du scan + câblage SNMP, hôte vu par le switch relié à son port, les autres au nuage", async () => {
  const db = freshDb();
  const net = createNetwork({ cidr: "192.168.77.0/24", name: "Bureau" } as never, db);
  const c = createCredential({ name: "Parc", community: "pub" }, db);
  const switchMib = new MibStore({
    "1.3.6.1.2.1.1.1.0": str("Switch test"), "1.3.6.1.2.1.1.5.0": str("sw-77"), "1.3.6.1.2.1.1.7.0": num(2), "1.0.8802.1.1.2.1.3.2.0": str(mac("aa:00:00:00:00:02")),
    "1.3.6.1.2.1.31.1.1.1.1.1": str("Gi1"), "1.3.6.1.2.1.2.2.1.3.1": num(6), "1.3.6.1.2.1.17.1.4.1.2.1": num(1),
    "1.3.6.1.2.1.17.7.1.2.2.1.2.1.187.0.0.0.0.9": num(1),
  });
  const last = (a: string) => Number(a.split(".")[3]);
  const scan = {
    ping: async (a: string) => ({ alive: [2, 10, 20].includes(last(a)), ms: 1 }),
    tcp: async () => "none" as const,
    neighbors: async () => new Map([["192.168.77.2", "aa:00:00:00:00:02"], ["192.168.77.10", "bb:00:00:00:00:09"]]),
    reverse: async (a: string) => { if (last(a) === 10) return ["pc-compta.exemple.fr."]; throw new Error("x"); },
  };
  const tried: string[] = [];
  const connect = (a: string): SnmpLike => { tried.push(a); if (a === "192.168.77.2") return switchMib; throw new Error("pas de SNMP"); };
  assert.equal(code(() => startDiscovery({ networkId: 999 }, db, { connect, scan })), "networkNotFound");
  const r = startDiscovery({ networkId: net.id, depth: 1 }, db, { connect, scan });
  await r.finished;
  assert.equal(discoveryStatus().status, "done", JSON.stringify(discoveryStatus()));
  assert.deepEqual([...new Set(tried)].sort(), ["192.168.77.10", "192.168.77.2", "192.168.77.20"]); // chaque hôte qui répond essayé en SNMP, aucun autre
  const t = getTopology(db);
  const by = (n: string) => t.devices.find((d) => d.name === n)!;
  assert.equal(by("sw-77").source, "snmp");
  assert.equal(by("pc-compta.exemple.fr").source, "scan");
  assert.equal(by("192.168.77.20").source, "scan");
  const cloud = t.devices.find((d) => d.kind === "network")!;
  assert.equal(cloud.name, "192.168.77.0/24 Bureau");
  const linkBetween = (x: number, y: number) => t.links.find((l) => (l.aDevice === x && l.bDevice === y) || (l.aDevice === y && l.bDevice === x));
  const pcLink = linkBetween(by("pc-compta.exemple.fr").id, by("sw-77").id)!;
  assert.equal(pcLink.source, "scan");
  assert.equal((pcLink.aDevice === by("sw-77").id ? pcLink.aPort : pcLink.bPort), "Gi1"); // le port vient de la table MAC du switch
  assert.ok(linkBetween(by("192.168.77.20").id, cloud.id)); // sans information de câblage : relié au nuage
  assert.ok(!linkBetween(by("pc-compta.exemple.fr").id, cloud.id));
  assert.equal(by("sw-77").clientCount, 0); // le PC est devenu un équipement : il n'est plus compté deux fois
  // relancer ne duplique rien
  await startDiscovery({ networkId: net.id, depth: 1 }, db, { connect, scan }).finished;
  const t2 = getTopology(db);
  assert.equal(t2.devices.length, t.devices.length);
  assert.equal(t2.links.length, t.links.length);
});

test("découverte d'un réseau sans identifiants SNMP : seulement les hôtes, reliés au nuage ; réseau public refusé", async () => {
  const db = freshDb();
  const net = createNetwork({ cidr: "192.168.78.0/24", name: "Invités" } as never, db);
  const pub = createNetwork({ cidr: "8.8.8.0/29", name: "Pub" } as never, db);
  assert.equal(code(() => startDiscovery({ networkId: pub.id }, db, {})), "scanNotPrivate");
  const scan = { ping: async (a: string) => ({ alive: a.endsWith(".5"), ms: 1 }), tcp: async () => "none" as const, neighbors: async () => new Map<string, string>(), reverse: async () => { throw new Error("x"); } };
  await startDiscovery({ networkId: net.id }, db, { scan, connect: () => { throw new Error("ne doit pas être appelé"); } }).finished;
  assert.equal(discoveryStatus().status, "done");
  const t = getTopology(db);
  assert.deepEqual(t.devices.map((d) => d.kind).sort(), ["network", "other"]);
  assert.equal(t.links.length, 1);
});

test("hôtes d'un scan : une MAC partagée (passerelle, proxy ARP) ne rattache personne à un port et n'est pas affichée", () => {
  const db = freshDb();
  const p = getActiveProject(db);
  const sw = Number(db.prepare("INSERT INTO topo_devices (project_id, name, kind, source, last_seen_at) VALUES (?, 'sw', 'switch', 'manual', ?)").run(p.id, new Date().toISOString()).lastInsertRowid);
  const SHARED = "48:a9:8a:db:0e:24";
  db.prepare("INSERT INTO topo_clients (device_id, mac, port, ip, vlan, last_seen_at) VALUES (?, ?, 'Gi1', NULL, NULL, ?)").run(sw, SHARED, new Date().toISOString());
  db.prepare("INSERT INTO topo_clients (device_id, mac, port, ip, vlan, last_seen_at) VALUES (?, ?, 'Gi2', NULL, NULL, ?)").run(sw, "bb:00:00:00:00:01", new Date().toISOString());
  const host = (n: number, mac: string | null) => ({ address: `10.9.9.${n}`, ms: 1, via: ["icmp"], hostname: null, mac });
  const hosts = [host(1, SHARED), host(2, SHARED), host(3, SHARED), host(4, SHARED), host(5, "bb:00:00:00:00:01")];
  applyScanHosts(db, p.id, { cidr: "10.9.9.0/24", name: "Test", gateway: "10.9.9.1" }, hosts);
  const t = getTopology(db);
  const dev = (a: string) => t.devices.find((d) => d.address === a)!;
  const cloud = t.devices.find((d) => d.kind === "network")!;
  const linked = (x: number, y: number) => t.links.some((l) => (l.aDevice === x && l.bDevice === y) || (l.aDevice === y && l.bDevice === x));
  for (const n of [2, 3, 4]) {
    assert.ok(!linked(dev(`10.9.9.${n}`).id, sw), `10.9.9.${n} : pas rattaché au switch par une MAC partagée`);
    assert.ok(linked(dev(`10.9.9.${n}`).id, cloud.id), `10.9.9.${n} : relié au nuage`);
    assert.ok(!(dev(`10.9.9.${n}`).info ?? "").includes("MAC"), "MAC partagée non affichée");
  }
  assert.ok(linked(dev("10.9.9.5").id, sw), "une MAC qui n'appartient qu'à un hôte rattache bien au port du switch");
  assert.ok((dev("10.9.9.5").info ?? "").includes("bb:00:00:00:00:01"));
});
