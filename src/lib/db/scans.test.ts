import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork } from "./queries";
import { allocateAddress, listAddresses } from "./ipam";
import { cancelScan, cleanScanOptions, deleteSchedule, diffScan, getScanReport, getSchedule, importScanHosts, runDueSchedules, scanNewHostCounts, setIgnored, setSchedule, startScan } from "./scans";
import { getMonitoring } from "./monitoring";
import { listAudit } from "./audit";
import { cleanHostname, normalizeMac, parseNeighbors, runScan } from "../scan/engine";
import { scanRefusal, scanTargets } from "../scan/targets";
import { PingUnavailableError } from "../monitor/ping";
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
const codeA = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try { await fn(); return null; } catch (e) { if (e instanceof ApiError) return e.code; throw e; }
};
const lastOctet = (a: string) => Number(a.split(".")[3]);
/** Faux réseau : .10 répond au ping, .20 seulement sur le port 443, .30 refuse la connexion, .40 a un nom. */
const fakeDeps = {
  ping: async (a: string) => ({ alive: lastOctet(a) === 10 || lastOctet(a) === 40, ms: 3 }),
  tcp: async (a: string, p: number) => (lastOctet(a) === 20 && p === 443 ? ("open" as const) : lastOctet(a) === 30 ? ("refused" as const) : ("none" as const)),
  neighbors: async () => new Map([["192.168.77.10", "aa:bb:cc:00:00:10"], ["192.168.77.40", "aa:bb:cc:00:00:40"]]),
  reverse: async (a: string) => { if (lastOctet(a) === 40) return ["Srv-40.exemple.fr."]; if (lastOctet(a) === 10) return ["evil name with spaces"]; throw new Error("ENOTFOUND"); },
};
const net24 = (db: Db, cidr = "192.168.77.0/24") => createNetwork({ cidr, name: "Scan" } as never, db).id;

test("cibles : hôtes sans adresse réseau ni broadcast ; /31 et /32 ; refus IPv6, trop grand, public", () => {
  const t = scanTargets("192.168.1.0/24");
  assert.equal(t.length, 254);
  assert.deepEqual([t[0], t.at(-1)], ["192.168.1.1", "192.168.1.254"]);
  assert.equal(scanTargets("10.0.0.0/22").length, 1022);
  assert.deepEqual(scanTargets("10.0.0.4/31"), ["10.0.0.4", "10.0.0.5"]);
  assert.deepEqual(scanTargets("10.0.0.9/32"), ["10.0.0.9"]);
  assert.deepEqual(scanTargets("2001:db8::/64"), []);
  assert.equal(scanRefusal("192.168.1.0/24"), null);
  assert.equal(scanRefusal("100.64.0.0/24"), null);
  assert.equal(scanRefusal("172.31.0.0/22"), null);
  assert.equal(scanRefusal("10.0.0.0/21"), "tooBig");
  assert.equal(scanRefusal("2001:db8::/120"), "ipv6");
  assert.equal(scanRefusal("8.8.8.0/24"), "notPrivate");
  assert.equal(scanRefusal("172.32.0.0/24"), "notPrivate");
  assert.equal(scanRefusal("169.254.0.0/24"), "notPrivate");
  assert.equal(scanRefusal("127.0.0.0/24"), "notPrivate");
  assert.equal(scanRefusal("8.8.8.0/24", true), null);
});

test("moteur : ping, port ouvert, refus (hôte présent), nom nettoyé, annulation, ping absent", async () => {
  const targets = scanTargets("192.168.77.0/24");
  const ac = new AbortController();
  const out = await runScan(targets, { icmp: true, ports: [443, 22], resolve: true }, ac.signal, undefined, fakeDeps);
  assert.deepEqual(out.hosts.map((h) => [h.address, h.via, h.hostname]), [
    ["192.168.77.10", ["icmp"], null], // nom DNS invalide : ignoré
    ["192.168.77.20", ["tcp:443"], null],
    ["192.168.77.30", ["tcp-refused"], null],
    ["192.168.77.40", ["icmp"], "Srv-40.exemple.fr"],
  ]);
  assert.equal(out.cancelled, false);
  // annulation : on s'arrête tôt
  const ac2 = new AbortController();
  let n = 0;
  const part = await runScan(targets, { icmp: true, ports: [], resolve: false }, ac2.signal, () => { if (++n === 40) ac2.abort(); }, fakeDeps);
  assert.equal(part.cancelled, true);
  assert.ok(n < 100, String(n));
  // commande ping absente : on continue avec les ports
  const noPing = await runScan(targets, { icmp: true, ports: [443], resolve: false }, new AbortController().signal, undefined, { ...fakeDeps, ping: async () => { throw new PingUnavailableError("ping"); } });
  assert.deepEqual(noPing.notes, ["icmpUnavailable"]);
  assert.deepEqual(noPing.hosts.map((h) => h.address), ["192.168.77.20", "192.168.77.30"]);
  assert.equal(cleanHostname(["bad name", "ok.example.com."]), "ok.example.com");
  assert.equal(cleanHostname(["-x", "a;b"]), null);
});

test("options : défauts, validation", () => {
  assert.deepEqual(cleanScanOptions(undefined), { icmp: true, ports: [22, 80, 443, 445, 3389], resolve: true });
  assert.deepEqual(cleanScanOptions({ icmp: false, ports: [80, 80] }), { icmp: false, ports: [80], resolve: true });
  assert.equal(code(() => cleanScanOptions({ ports: [1] })), "scanInvalidPorts");
  assert.equal(code(() => cleanScanOptions({ ports: "80" })), "scanInvalidPorts");
  assert.equal(code(() => cleanScanOptions({ icmp: false, ports: [] })), "scanNoMethod");
  assert.equal(code(() => cleanScanOptions({ icmp: "oui" })), "invalidBody");
  assert.equal(code(() => cleanScanOptions([])), "invalidBody");
});

test("scan complet : lancé, enregistré, comparé à l'inventaire, un seul à la fois", async () => {
  const db = freshDb();
  const id = net24(db);
  allocateAddress(id, { address: "192.168.77.10", hostname: "pare-feu" }, db); // connue et répond
  allocateAddress(id, { address: "192.168.77.50", hostname: "fantome" }, db); // utilisée mais silencieuse
  allocateAddress(id, { address: "192.168.77.60", status: "reserved" }, db); // réservée silencieuse : normale
  const { scan, finished } = startScan(id, { ports: [443] }, db, fakeDeps);
  assert.equal(scan.status, "running");
  assert.equal(scan.total, 254);
  assert.equal(code(() => startScan(id, undefined, db, fakeDeps)), "scanBusy");
  assert.equal(getScanReport(id, db).scan?.status, "running");
  await finished;
  const r = getScanReport(id, db);
  assert.equal(r.scan?.status, "done");
  assert.deepEqual(r.counts, { new: 3, known: 1, silent: 1, ignored: 0 });
  const by = (a: string) => r.rows.find((x) => x.address === a)!;
  assert.equal(by("192.168.77.10").state, "known");
  assert.equal(by("192.168.77.10").hostname, "pare-feu");
  assert.equal(by("192.168.77.20").state, "new");
  assert.equal(by("192.168.77.40").discoveredHostname, "Srv-40.exemple.fr");
  assert.equal(by("192.168.77.50").state, "silent");
  assert.ok(!r.rows.some((x) => x.address === "192.168.77.60"));
  // un nouveau scan est possible ensuite
  const again = startScan(id, { ports: [] }, db, fakeDeps);
  await again.finished;
  assert.equal((db.prepare("SELECT COUNT(*) c FROM scans").get() as { c: number }).c, 2);
});

test("import : hôtes découverts seulement, nom DNS repris, tout ou rien, déjà inventoriés ignorés", async () => {
  const db = freshDb();
  const id = net24(db);
  await startScan(id, { ports: [443] }, db, fakeDeps).finished;
  assert.equal(code(() => importScanHosts(id, [], db)), "invalidBody");
  assert.equal(code(() => importScanHosts(id, ["192.168.77.99"], db)), "scanHostUnknown");
  // une adresse inconnue annule tout l'import
  assert.equal(code(() => importScanHosts(id, ["192.168.77.40", "192.168.77.99"], db)), "scanHostUnknown");
  assert.equal(listAddresses(id, db).length, 0);
  const r = importScanHosts(id, ["192.168.77.40", "192.168.77.20", "192.168.77.40"], db);
  assert.deepEqual([r.imported, r.skipped], [2, 0]);
  const a = listAddresses(id, db);
  assert.deepEqual(a.map((x) => [x.address, x.hostname, x.status]), [["192.168.77.20", null, "used"], ["192.168.77.40", "Srv-40.exemple.fr", "used"]]);
  assert.match(a[0].description ?? "", /^Scan \d{4}-\d{2}-\d{2}$/);
  assert.equal((db.prepare("SELECT used_ips u FROM networks WHERE id = ?").get(id) as { u: number }).u >= 2, true);
  // maintenant connues : l'import les ignore, et le rapport les classe « known »
  const again = importScanHosts(id, ["192.168.77.40", "192.168.77.30"], db);
  assert.deepEqual([again.imported, again.skipped], [1, 1]);
  assert.equal(getScanReport(id, db).counts.new, 1); // reste 192.168.77.10
  assert.equal(code(() => importScanHosts(net24(db, "192.168.78.0/24"), ["192.168.78.1"], db)), "scanNone");
});

test("refus : réseau public, trop grand, IPv6 ; annulation hors scan ; réseau d'un autre projet", async () => {
  const db = freshDb();
  assert.equal(code(() => startScan(net24(db, "8.8.8.0/24"), undefined, db, fakeDeps)), "scanNotPrivate");
  assert.equal(code(() => startScan(net24(db, "10.8.0.0/21"), undefined, db, fakeDeps)), "scanTooBig");
  assert.equal(code(() => startScan(createNetwork({ cidr: "fd00:1::/64", name: "v6" } as never, db).id, undefined, db, fakeDeps)), "scanIpv6");
  assert.equal(code(() => startScan(net24(db, "8.8.4.0/24"), undefined, db, fakeDeps, { IP_ARCHITECT_SCAN_PUBLIC: "1" } as never)), null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(code(() => cancelScan(net24(db, "192.168.90.0/24"), db)), "scanNotRunning");
  assert.equal(code(() => startScan(99999, undefined, db, fakeDeps)), "networkNotFound");
});

test("annulation : le résultat partiel est enregistré comme « cancelled »", async () => {
  const db = freshDb();
  const id = net24(db);
  let first = true;
  const slow = { ...fakeDeps, ping: async (a: string) => { if (first) { first = false; cancelScan(id, db); } return fakeDeps.ping(a); } };
  const { finished } = startScan(id, { ports: [] }, db, slow);
  await finished;
  const r = getScanReport(id, db);
  assert.equal(r.scan?.status, "cancelled");
  assert.ok((r.scan?.alive ?? 0) < 4);
});

test("diffScan : pur", () => {
  const d = diffScan(
    [{ address: "10.0.0.2", ms: 1, via: ["icmp"], hostname: "a", mac: null }, { address: "10.0.0.3", ms: null, via: ["tcp:22"], hostname: null, mac: null }],
    [{ address: "10.0.0.2", status: "used", hostname: "x" }, { address: "10.0.0.9", status: "used", hostname: null }, { address: "10.0.0.10", status: "reserved", hostname: null }],
  );
  assert.deepEqual(d.rows.map((r) => [r.address, r.state]), [["10.0.0.2", "known"], ["10.0.0.3", "new"], ["10.0.0.9", "silent"]]);
  assert.deepEqual(d.counts, { new: 1, known: 1, silent: 1, ignored: 0 });
});

test("MAC : normalisation, lecture de ip neigh / arp (Linux, macOS, Windows), entrées inutilisables ignorées", () => {
  assert.equal(normalizeMac("AA-BB-0C-0-1-2F"), "aa:bb:0c:00:01:2f");
  for (const bad of ["00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01", "aa:bb:cc", "zz:bb:cc:dd:ee:ff"]) assert.equal(normalizeMac(bad), null, bad);
  const linux = "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:01 REACHABLE\n192.168.1.7 dev eth0  FAILED\n192.168.1.9 dev eth0 lladdr AA:BB:CC:DD:EE:09 STALE\n";
  assert.deepEqual([...parseNeighbors(linux)], [["192.168.1.1", "aa:bb:cc:dd:ee:01"], ["192.168.1.9", "aa:bb:cc:dd:ee:09"]]);
  const mac = "? (192.168.1.1) at aa:b:cc:dd:ee:1 on en0 ifscope [ethernet]\n? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]\n";
  assert.deepEqual([...parseNeighbors(mac)], [["192.168.1.1", "aa:0b:cc:dd:ee:01"]]);
  const win = "Interface : 192.168.1.20 --- 0x7\n  Adresse Internet      Adresse physique      Type\n  192.168.1.1           aa-bb-cc-dd-ee-01     dynamique\n  192.168.1.255         ff-ff-ff-ff-ff-ff     statique\n  224.0.0.22            01-00-5e-00-00-16     statique\n";
  assert.deepEqual([...parseNeighbors(win)], [["192.168.1.1", "aa:bb:cc:dd:ee:01"]]);
  assert.equal(parseNeighbors("999.1.1.1 aa:bb:cc:dd:ee:01").size, 0);
});

test("MAC : lue après le scan, gardée dans le résultat, reprise à l'import, changement signalé au scan suivant", async () => {
  const db = freshDb();
  const id = net24(db);
  await startScan(id, { ports: [443] }, db, fakeDeps).finished;
  let r = getScanReport(id, db);
  assert.deepEqual(r.rows.map((x) => [x.address, x.mac]), [["192.168.77.10", "aa:bb:cc:00:00:10"], ["192.168.77.20", null], ["192.168.77.30", null], ["192.168.77.40", "aa:bb:cc:00:00:40"]]);
  assert.ok(r.rows.every((x) => x.prevMac === null));
  importScanHosts(id, ["192.168.77.10"], db);
  assert.match(listAddresses(id, db)[0].description ?? "", /MAC aa:bb:cc:00:00:10/);
  // même adresse, autre matériel
  await startScan(id, { ports: [443] }, db, { ...fakeDeps, neighbors: async () => new Map([["192.168.77.10", "de:ad:be:ef:00:01"], ["192.168.77.40", "aa:bb:cc:00:00:40"]]) }).finished;
  r = getScanReport(id, db);
  const row = r.rows.find((x) => x.address === "192.168.77.10")!;
  assert.deepEqual([row.mac, row.prevMac], ["de:ad:be:ef:00:01", "aa:bb:cc:00:00:10"]);
  assert.equal(r.rows.find((x) => x.address === "192.168.77.40")!.prevMac, null);
});

test("hôtes ignorés : ne comptent plus comme nouveaux, se rétablissent, adresses hors réseau refusées", async () => {
  const db = freshDb();
  const id = net24(db);
  await startScan(id, { ports: [443] }, db, fakeDeps).finished;
  assert.deepEqual(getScanReport(id, db).counts, { new: 4, known: 0, silent: 0, ignored: 0 });
  assert.equal(setIgnored(id, ["192.168.77.20", "192.168.77.20"], true, db).changed, 1);
  assert.deepEqual(getScanReport(id, db).counts, { new: 3, known: 0, silent: 0, ignored: 1 });
  assert.equal(getScanReport(id, db).rows.find((x) => x.address === "192.168.77.20")!.state, "ignored");
  assert.equal(setIgnored(id, ["192.168.77.20"], true, db).changed, 0);
  assert.equal(code(() => setIgnored(id, ["10.9.9.9"], true, db)), "addressOutsideNetwork");
  assert.equal(code(() => setIgnored(id, ["pas une ip"], true, db)), "addressOutsideNetwork");
  assert.equal(code(() => setIgnored(id, [], true, db)), "invalidBody");
  assert.equal(code(() => setIgnored(id, ["192.168.77.20"], "oui" as never, db)), "invalidBody");
  assert.equal(setIgnored(id, ["192.168.77.20"], false, db).changed, 1);
  assert.equal(getScanReport(id, db).counts.new, 4);
});

test("programmation : validation, un par réseau, limite, suppression, refus des réseaux non scannables", () => {
  const db = freshDb();
  const id = net24(db);
  assert.equal(getSchedule(id, db), null);
  assert.equal(code(() => setSchedule(id, {}, db)), "invalidBody");
  assert.equal(code(() => setSchedule(id, { everyHours: 5 }, db)), "scanInvalidSchedule");
  assert.equal(code(() => setSchedule(id, { enabled: "oui" as never }, db)), "invalidBody");
  assert.equal(code(() => setSchedule(id, { ports: [1] }, db)), "scanInvalidPorts");
  const s = setSchedule(id, { everyHours: 6, ports: [22] }, db);
  assert.deepEqual([s.everyHours, s.enabled, s.alert, s.options.ports, s.lastStartedAt, s.nextAt], [6, true, true, [22], null, null]);
  const t = setSchedule(id, { alert: false }, db); // modification partielle : le reste est conservé
  assert.deepEqual([t.everyHours, t.alert, t.options.ports], [6, false, [22]]);
  assert.equal(code(() => setSchedule(createNetwork({ cidr: "8.8.4.0/24", name: "pub" } as never, db).id, { everyHours: 1 }, db)), "scanNotPrivate");
  assert.equal(code(() => setSchedule(createNetwork({ cidr: "10.64.0.0/16", name: "big" } as never, db).id, { everyHours: 1 }, db)), "scanTooBig");
  deleteSchedule(id, db);
  assert.equal(getSchedule(id, db), null);
  assert.equal(code(() => deleteSchedule(id, db)), "scanNoSchedule");
  for (let i = 0; i < 20; i++) setSchedule(net24(db, `192.168.${100 + i}.0/24`), { everyHours: 24 }, db);
  assert.equal(code(() => setSchedule(net24(db, "192.168.200.0/24"), { everyHours: 24 }, db)), "scanScheduleLimit");
});

test("planificateur : lance le plus en retard, respecte le délai, un seul scan à la fois, audit sans utilisateur", async () => {
  const db = freshDb();
  const a = net24(db, "192.168.77.0/24");
  const b = net24(db, "192.168.78.0/24");
  setSchedule(a, { everyHours: 6, ports: [443], resolve: false }, db);
  setSchedule(b, { everyHours: 24, ports: [443], resolve: false }, db);
  const t0 = new Date("2026-10-27T10:00:00Z");
  const first = runDueSchedules(db, t0, fakeDeps)!;
  assert.equal(first.networkId, a);
  assert.equal(runDueSchedules(db, t0, fakeDeps), null); // un scan tourne déjà
  await first.finished;
  const second = runDueSchedules(db, new Date(t0.getTime() + 1000), fakeDeps)!; // a vient de partir : b est le prochain
  assert.equal(second.networkId, b);
  await second.finished;
  assert.equal(runDueSchedules(db, new Date(t0.getTime() + 3600_000), fakeDeps), null); // rien n'est dû dans l'heure
  const later = runDueSchedules(db, new Date(t0.getTime() + 6 * 3600_000 + 5000), fakeDeps)!; // 6 h plus tard : a seulement
  assert.equal(later.networkId, a);
  await later.finished;
  assert.deepEqual(getScanReport(a, db).scan?.notes, ["scheduled"]);
  assert.equal(getSchedule(a, db)!.nextAt, new Date(t0.getTime() + 6 * 3600_000 + 5000 + 6 * 3600_000).toISOString());
  const rows = (listAudit({ limit: 50 } as never, db).rows as { entity: string; username: string | null; detail: string | null }[]).filter((r) => r.entity === "scan");
  assert.ok(rows.length >= 3 && rows.every((r) => r.username === null && r.detail === "scan programmé"));
  // désactivée : plus lancée
  setSchedule(a, { enabled: false }, db);
  assert.equal(getSchedule(a, db)!.nextAt, null);
  const last = runDueSchedules(db, new Date(t0.getTime() + 99 * 3600_000), fakeDeps)!;
  assert.equal(last.networkId, b);
  await last.finished; // le scan en cours est global : on l'attend avant le test suivant
});

test("alerte : un scan programmé avec alerte fait apparaître les hôtes inconnus dans la supervision ; inventoriés ou ignorés, plus", async () => {
  const db = freshDb();
  const id = net24(db);
  setSchedule(id, { everyHours: 1, ports: [443], resolve: false }, db);
  assert.equal(scanNewHostCounts(db, 1).length, 0); // jamais scanné
  await runDueSchedules(db, new Date(), fakeDeps)!.finished;
  const find = () => getMonitoring(db).findings.filter((f) => f.kind === "scanNewHosts");
  assert.equal(find().length, 1);
  assert.deepEqual([find()[0].severity, find()[0].params.count, find()[0].href], ["warning", 4, "/scan"]);
  assert.match(String(find()[0].params.hosts), /192\.168\.77\.10/);
  allocateAddress(id, { address: "192.168.77.10", status: "used" }, db);
  assert.equal(find()[0].params.count, 3);
  setIgnored(id, ["192.168.77.20"], true, db);
  assert.equal(find()[0].params.count, 2);
  setIgnored(id, ["192.168.77.30", "192.168.77.40"], true, db);
  assert.equal(find().length, 0);
  setIgnored(id, ["192.168.77.40"], false, db);
  assert.equal(find().length, 1);
  setSchedule(id, { alert: false }, db); // sans alerte : silence
  assert.equal(find().length, 0);
});
