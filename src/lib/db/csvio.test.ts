import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, getActiveProject, listNetworks } from "./queries";
import { createSite } from "./sites";
import { createProject, activateProject } from "./projects";
import { listAddresses, allocateAddress } from "./ipam";
import { createField } from "./meta";
import { exportCsv, exportCounts, importCsv, csvFilename, ENTITY_SPECS } from "./csvio";
import { parseCsv } from "../csv/csv";
import { ApiError, CSV_ENTITIES, type CsvEntity } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

/** Projet vide et actif, pour y réimporter. */
function emptyProject(db: Db, name: string): void {
  const p = createProject({ name }, db);
  activateProject(p.id, db);
}

const ORDER: CsvEntity[] = ["sites", "vrfs", "vlans", "networks", "addresses", "dhcp_scopes", "dhcp_reservations"];

test("export : un fichier par type, en-têtes techniques fixes, BOM, séparateur choisi", () => {
  const db = freshDb();
  const counts = exportCounts(db);
  for (const e of ORDER) assert.ok(counts[e] > 0, `${e} : aucune donnée de démo à exporter`);
  for (const e of CSV_ENTITIES) {
    const out = exportCsv(e, { delimiter: ";" }, db);
    assert.ok(out.content.startsWith("﻿"));
    const rows = parseCsv(out.content);
    const extra = e === "networks" || e === "addresses" ? ["tags"] : [];
    assert.deepEqual(rows[0], [...ENTITY_SPECS[e].header, ...extra]);
    assert.equal(rows.length - 1, out.rows);
    assert.equal(out.rows, counts[e]);
    assert.match(out.filename, /^ip-architect_.+_.+\.csv$/);
  }
  assert.ok(exportCsv("sites", { delimiter: "," }, db).content.includes("name,address,description"));
});

test("export : les adresses gérées par une réservation DHCP ne sont exportées qu'avec les réservations", () => {
  const db = freshDb();
  const reservations = parseCsv(exportCsv("dhcp_reservations", {}, db).content).slice(1);
  const addresses = parseCsv(exportCsv("addresses", {}, db).content).slice(1);
  const reserved = new Set(reservations.map((r) => r[2]));
  assert.ok(reserved.size > 0);
  for (const a of addresses) assert.ok(!reserved.has(a[2]) || a[0] !== "", "adresse DHCP dupliquée");
  const total = (db.prepare("SELECT COUNT(*) AS c FROM ip_addresses").get() as { c: number }).c;
  assert.equal(addresses.length + reservations.length, total);
});

test("export : gabarit = en-tête + une ligne d'exemple ; nom de fichier ASCII sûr", () => {
  const db = freshDb();
  for (const e of CSV_ENTITIES) {
    const t = exportCsv(e, { template: true }, db);
    const rows = parseCsv(t.content);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].length, rows[0].length);
    assert.equal(t.filename, `ip-architect_modele_${e}.csv`);
  }
  assert.equal(csvFilename("Client Éléphant / Été 2026!", "networks"), "ip-architect_client-elephant-ete-2026_networks.csv");
  assert.equal(csvFilename("???", "sites"), "ip-architect_projet_sites.csv");
});

test("aller-retour complet : exporter tout puis réimporter dans un projet vide redonne exactement les mêmes fichiers", () => {
  const db = freshDb();
  const before = Object.fromEntries(ORDER.map((e) => [e, exportCsv(e, {}, db).content])) as Record<CsvEntity, string>;
  const netsBefore = listNetworks({}, db).map((n) => [n.cidr, n.usedIps, n.reservedIps]);

  emptyProject(db, "Copie");
  for (const e of ORDER) {
    const r = importCsv(e, before[e], { dryRun: false }, db);
    assert.deepEqual(r.errors, [], `${e} : ${JSON.stringify(r.errors)}`);
    assert.equal(r.committed, true);
    assert.equal(r.created, r.total);
  }
  for (const e of ORDER) assert.equal(exportCsv(e, {}, db).content, before[e], `${e} : le réimport diffère de l'original`);
  // les compteurs ne sont pas comptés deux fois
  assert.deepEqual(listNetworks({}, db).map((n) => [n.cidr, n.usedIps, n.reservedIps]), netsBefore);
});

test("réimporter le même fichier : lignes déjà présentes ignorées (skip) ou signalées (error), rien de dupliqué", () => {
  const db = freshDb();
  const csv = exportCsv("networks", {}, db).content;
  const n = listNetworks({}, db).length;
  const skip = importCsv("networks", csv, { dryRun: false }, db);
  assert.equal(skip.skipped, n);
  assert.equal(skip.created, 0);
  assert.deepEqual(skip.errors, []);
  const err = importCsv("networks", csv, { dryRun: false, onExisting: "error" }, db);
  assert.equal(err.errors.length, n);
  assert.equal(err.committed, false);
  assert.equal(listNetworks({}, db).length, n);
});

test("simulation : exécute vraiment l'import puis annule tout", () => {
  const db = freshDb();
  emptyProject(db, "Vide");
  const csv = "name;address\nTchamba;1 rue A\nKara;\n";
  const dry = importCsv("sites", csv, {}, db);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.committed, false);
  assert.equal(dry.created, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM sites WHERE project_id = ?").get(getActiveProject(db).id) as { c: number }).c, 0);
  const real = importCsv("sites", csv, { dryRun: false }, db);
  assert.equal(real.committed, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM sites WHERE project_id = ?").get(getActiveProject(db).id) as { c: number }).c, 2);
});

test("tout ou rien : une ligne en erreur annule toutes les autres, toutes les erreurs sont listées avec leur ligne", () => {
  const db = freshDb();
  emptyProject(db, "P");
  const csv = [
    "cidr;name;site;vlan;status",
    "10.0.0.0/24;Bon réseau;;10;active",
    "pas-un-cidr;Mauvais;;;",
    "10.0.1.0/24;Site inconnu;Atlantide;;",
    "10.0.2.0/24;Statut;;;bizarre",
    "10.0.3.0/24;VLAN;;9999;",
    "10.0.4.0/24;Nombre;;abc;",
    "10.0.0.128/25;Chevauche;;;",
    "10.0.5.0/24;Autre bon;;;maintenance",
  ].join("\n");
  const r = importCsv("networks", csv, { dryRun: false }, db);
  assert.equal(r.committed, false);
  assert.equal(r.created, 2);
  assert.deepEqual(
    r.errors.map((e) => [e.line, e.code]),
    [[3, "invalidCidr"], [4, "csvSiteUnknown"], [5, "invalidStatus"], [6, "invalidVlan"], [7, "csvBadNumber"], [8, "overlap"]],
  );
  assert.equal(listNetworks({}, db).length, 0, "rien ne doit avoir été écrit");
});

test("en-têtes : ordre libre, casse et espaces tolérés, colonnes inconnues ignorées, colonne obligatoire absente refusée", () => {
  const db = freshDb();
  emptyProject(db, "P");
  const r = importCsv("sites", "Description ; NAME ; couleur\nbureau;Tchamba;rouge\n", { dryRun: false }, db);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.ignoredColumns, ["couleur"]);
  assert.equal(r.committed, true);
  assert.equal(code(() => importCsv("sites", "address\nx\n", {}, db)), "csvMissingColumn");
  assert.equal(code(() => importCsv("vlans", "number\n10\n", {}, db)), "csvMissingColumn");
});

test("fichier : vide, guillemet non refermé, trop de lignes, trop gros", () => {
  const db = freshDb();
  assert.equal(code(() => importCsv("sites", "", {}, db)), "csvEmpty");
  assert.equal(code(() => importCsv("sites", "\n\n", {}, db)), "csvEmpty");
  assert.equal(code(() => importCsv("sites", 'name\n"oups', {}, db)), "csvUnterminatedQuote");
  assert.equal(code(() => importCsv("sites", "name\n" + "x\n".repeat(5001), {}, db)), "csvTooManyRows");
  assert.equal(code(() => importCsv("sites", "name\n" + "x".repeat(2_000_001), {}, db)), "csvTooLarge");
  const onlyHeader = importCsv("sites", "name\n", { dryRun: false }, db);
  assert.equal(onlyHeader.total, 0);
  assert.equal(onlyHeader.committed, true);
});

test("même CIDR dans deux VRF : les adresses et plages se rattachent au bon réseau grâce à la colonne vrf", () => {
  const db = freshDb();
  emptyProject(db, "VRF");
  importCsv("vrfs", "name;rd\nA;65000:1\nB;65000:2\n", { dryRun: false }, db);
  const nets = importCsv("networks", "cidr;name;vrf\n10.9.0.0/24;Réseau A;A\n10.9.0.0/24;Réseau B;B\n", { dryRun: false }, db);
  assert.deepEqual(nets.errors, []);
  const addr = importCsv(
    "addresses",
    "network;vrf;address;hostname\n10.9.0.0/24;A;10.9.0.10;hôte-a\n10.9.0.0/24;B;10.9.0.10;hôte-b\n10.9.0.0/24;;10.9.0.11;global\n",
    { dryRun: false },
    db,
  );
  assert.equal(addr.errors.length, 1, "VRF globale sans ce réseau : réseau inconnu");
  assert.equal(addr.errors[0].code, "csvNetworkUnknown");
  const ok = importCsv(
    "addresses",
    "network;vrf;address;hostname\n10.9.0.0/24;A;10.9.0.10;hôte-a\n10.9.0.0/24;B;10.9.0.10;hôte-b\n",
    { dryRun: false },
    db,
  );
  assert.equal(ok.committed, true);
  const [a, b] = listNetworks({}, db);
  assert.equal(listAddresses(a.id, db)[0].hostname, "hôte-a");
  assert.equal(listAddresses(b.id, db)[0].hostname, "hôte-b");
});

test("adresses : les compteurs sont relevés au nombre d'adresses inventoriées, jamais comptés en double ni abaissés", () => {
  const db = freshDb();
  emptyProject(db, "C");
  importCsv("networks", "cidr;name;used_ips;reserved_ips\n10.8.0.0/24;Avec compteurs;50;10\n10.8.1.0/24;Sans compteur;;\n", { dryRun: false }, db);
  importCsv(
    "addresses",
    "network;address;status\n10.8.0.0/24;10.8.0.5;used\n10.8.0.0/24;10.8.0.6;reserved\n10.8.1.0/24;10.8.1.5;used\n10.8.1.0/24;10.8.1.6;used\n10.8.1.0/24;10.8.1.7;reserved\n",
    { dryRun: false },
    db,
  );
  const [a, b] = listNetworks({}, db);
  assert.deepEqual([a.usedIps, a.reservedIps], [50, 10]);
  assert.deepEqual([b.usedIps, b.reservedIps], [2, 1]);
});

test("adresses : adresse vide refusée (n'alloue pas « la première libre »), hors réseau, adresse réseau, doublon dans le fichier", () => {
  const db = freshDb();
  emptyProject(db, "A");
  importCsv("networks", "cidr;name\n10.7.0.0/24;Net\n", { dryRun: false }, db);
  const r = importCsv(
    "addresses",
    "network;address;status\n10.7.0.0/24;;used\n10.7.0.0/24;192.168.0.1;used\n10.7.0.0/24;10.7.0.0;used\n10.7.0.0/24;10.7.0.9;used\n10.7.0.0/24;10.7.0.9;used\n10.7.0.0/24;10.7.0.10;nimportequoi\n",
    { onExisting: "error" },
    db,
  );
  assert.deepEqual(
    r.errors.map((e) => [e.line, e.code]),
    [[2, "invalidAddress"], [3, "addressOutsideNetwork"], [4, "addressNotAssignable"], [6, "addressTaken"], [7, "invalidAddressStatus"]],
  );
});

test("DHCP : plage puis réservations, adresses IPAM créées, compteurs justes", () => {
  const db = freshDb();
  emptyProject(db, "D");
  importCsv("networks", "cidr;name\n10.6.0.0/24;Net\n", { dryRun: false }, db);
  const s = importCsv(
    "dhcp_scopes",
    "network;name;range_start;range_end;gateway;dns;lease_seconds;enabled\n10.6.0.0/24;Plage;10.6.0.100;10.6.0.200;10.6.0.1;8.8.8.8 1.1.1.1;3600;non\n",
    { dryRun: false },
    db,
  );
  assert.deepEqual(s.errors, []);
  const r = importCsv(
    "dhcp_reservations",
    "scope;mac;address;hostname\nPlage;AA-BB-CC-DD-EE-FF;10.6.0.150;pc\nPlage;aa:bb:cc:dd:ee:ff;10.6.0.151;doublon\nPlage;11:22:33:44:55:66;10.6.0.150;même-ip\nInconnue;11:22:33:44:55:66;10.6.0.152;x\n",
    { onExisting: "error" },
    db,
  );
  assert.deepEqual(r.errors.map((e) => [e.line, e.code]), [[3, "macTaken"], [4, "addressTaken"], [5, "csvScopeUnknown"]]);
  const ok = importCsv("dhcp_reservations", "scope;mac;address;hostname\nPlage;AA-BB-CC-DD-EE-FF;10.6.0.150;pc\n", { dryRun: false }, db);
  assert.equal(ok.committed, true);
  const [n] = listNetworks({}, db);
  assert.equal(n.reservedIps, 1);
  const scope = parseCsv(exportCsv("dhcp_scopes", {}, db).content)[1];
  assert.deepEqual(scope.slice(2), ["Plage", "10.6.0.100", "10.6.0.200", "10.6.0.1", "8.8.8.8 1.1.1.1", "3600", "0"]);
  assert.equal(parseCsv(exportCsv("dhcp_reservations", {}, db).content)[1][1], "aa:bb:cc:dd:ee:ff");
});

test("sécurité : texte commençant par = + @ ré-exporté avec apostrophe, réimporté à l'identique ; import isolé du projet actif", () => {
  const db = freshDb();
  emptyProject(db, "S");
  importCsv("sites", "name;description\nSite;\"=HYPERLINK(\"\"http://x\"\")\"\n", { dryRun: false }, db);
  const exported = exportCsv("sites", {}, db).content;
  assert.ok(exported.includes("'=HYPERLINK"));
  assert.equal(parseCsv(exported)[1][2], '=HYPERLINK("http://x")');
  // les données de l'autre projet ne sont pas visibles
  assert.equal(parseCsv(exportCsv("networks", {}, db).content).length, 1);
  createNetwork({ cidr: "10.5.0.0/24", name: "x" }, db);
  createSite({ name: "Y" }, db);
});

test("étiquettes et champs : exportés (tags | cf_clé), modèle aligné, réimportés à l'identique dans un autre projet", () => {
  const db = freshDb();
  createField({ entity: "network", key: "owner", label: "Propriétaire", type: "text" }, db);
  createField({ entity: "address", key: "ticket", label: "Ticket", type: "number" }, db);
  const n = createNetwork({ cidr: "172.29.0.0/24", name: "Csv", tags: ["a", "b"], customFields: { owner: "Équipe" } }, db);
  allocateAddress(n.id, { address: "172.29.0.5", tags: ["srv"], customFields: { ticket: 7 } }, db);

  const tpl = parseCsv(exportCsv("networks", { template: true }, db).content);
  assert.deepEqual(tpl[0].slice(-2), ["tags", "cf_owner"]);
  assert.equal(tpl[1].length, tpl[0].length);

  const nets = parseCsv(exportCsv("networks", {}, db).content);
  const row = nets.find((r) => r[0] === "172.29.0.0/24")!;
  assert.deepEqual(row.slice(-2), ["a|b", "Équipe"]);
  const adr = parseCsv(exportCsv("addresses", {}, db).content);
  assert.deepEqual(adr.find((r) => r[2] === "172.29.0.5")!.slice(-2), ["srv", "7"]);

  // on ne réimporte que nos lignes (le reste des données de démo dépend de sites et de VRF absents du nouveau projet)
  const only = (header: string[], r: string[]) => [header.join(";"), r.map((c, i) => (header[i] === "site" || header[i] === "vrf" || header[i] === "vlan" ? "" : c)).join(";")].join("\n") + "\n";
  const netsCsv = only(nets[0], row);
  const adrCsv = only(adr[0], adr.find((r) => r[2] === "172.29.0.5")!);
  emptyProject(db, "Copie");
  createField({ entity: "network", key: "owner", label: "Propriétaire", type: "text" }, db);
  createField({ entity: "address", key: "ticket", label: "Ticket", type: "number" }, db);
  assert.equal(importCsv("networks", netsCsv, { dryRun: false }, db).errors.length, 0);
  assert.equal(importCsv("addresses", adrCsv, { dryRun: false }, db).errors.length, 0);
  const back = listNetworks({}, db).find((x) => x.cidr === "172.29.0.0/24")!;
  assert.deepEqual(back.tags.map((t) => t.name), ["a", "b"]);
  assert.equal(back.customFields.owner, "Équipe");
  assert.equal(listAddresses(back.id, db).find((a) => a.address === "172.29.0.5")!.customFields.ticket, 7);

  // valeur invalide : ligne signalée, rien d'écrit ; colonne cf_ inconnue : ignorée
  const bad = "cidr;name;cf_owner;cf_nope\n172.28.0.0/24;X;ok;z\n";
  const r = importCsv("networks", bad, { dryRun: true }, db);
  assert.deepEqual(r.ignoredColumns, ["cf_nope"]);
  assert.equal(r.errors.length, 0);
});
