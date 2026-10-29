import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { seedDatabase } from "./seed";
import { createNetwork, listNetworks } from "./queries";
import { createSite } from "./sites";
import { createProject, activateProject } from "./projects";
import { getReport, REPORT_KINDS, type ReportTable } from "./reports";
import { csvCell, displayCell } from "../reportFormat";
import { dictionaries } from "../i18n";
import { parseCsv, toCsv } from "../csv/csv";
import { ApiError } from "../types";

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedDatabase(db);
  return db;
}

const fr = dictionaries.fr;
const en = dictionaries.en;
const col = (t: ReportTable, key: string) => t.columns.findIndex((c) => c.key === key);

test("rapports : rapport inconnu -> invalidReport (404)", () => {
  const db = freshDb();
  assert.throws(
    () => getReport("nimporte", db),
    (e) => e instanceof ApiError && e.code === "invalidReport" && e.status === 404,
  );
});

test("rapports : chaque rapport produit des tableaux cohérents (largeur des lignes = colonnes, libellés traduits)", () => {
  const db = freshDb();
  for (const kind of REPORT_KINDS) {
    const r = getReport(kind, db);
    assert.ok(r.tables.length > 0, kind);
    for (const table of r.tables) {
      assert.ok(table.id in fr.reports.tables, `${kind}: titre ${table.id}`);
      for (const c of table.columns) {
        assert.ok(c.key in fr.reports.columns, `${kind}: colonne ${c.key}`);
        assert.ok(c.key in en.reports.columns);
      }
      for (const row of table.rows) assert.equal(row.length, table.columns.length, `${kind}/${table.id}`);
      if (table.footer) assert.equal(table.footer.length, table.columns.length);
      // toute valeur de type « status » a un libellé dans les deux langues
      table.columns.forEach((c, i) => {
        if (c.type !== "status") return;
        for (const row of table.rows) {
          assert.ok(String(row[i]) in fr.reports.values, `${kind}: valeur ${row[i]}`);
          assert.ok(String(row[i]) in en.reports.values);
        }
      });
    }
  }
});

test("rapports : la synthèse recoupe les réseaux et l'IPv4 de la base", () => {
  const db = freshDb();
  const nets = listNetworks({}, db);
  const totals = getReport("summary", db).tables[0];
  const get = (k: string) => totals.rows.find((r) => r[0] === k)![1];
  assert.equal(get("networks"), nets.length);
  assert.equal(get("networksV4"), nets.filter((n) => n.version === 4).length);
  assert.equal(get("networksV6"), nets.filter((n) => n.version === 6).length);
  const v4 = nets.filter((n) => n.version === 4);
  const cap = v4.reduce((a, n) => a + n.capacity, 0);
  const used = v4.reduce((a, n) => a + n.usedIps, 0);
  const res = v4.reduce((a, n) => a + n.reservedIps, 0);
  assert.equal(get("v4Capacity"), cap);
  assert.equal(get("v4Free"), cap - used - res);
  assert.ok(Math.abs((get("v4Occupancy") as number) - ((used + res) / cap) * 100) < 1e-9);
  // répartition par statut : la somme des parts vaut 100 % et celle des nombres vaut le total
  const st = getReport("summary", db).tables[1];
  assert.equal(st.rows.reduce((a, r) => a + (r[1] as number), 0), nets.length);
  assert.ok(Math.abs(st.rows.reduce((a, r) => a + (r[2] as number), 0) - 100) < 1e-9);
});

test("rapports : par site — les totaux du pied égalent la somme des lignes, « Sans site » apparaît quand il y a un réseau sans site", () => {
  const db = freshDb();
  createNetwork({ cidr: "172.16.0.0/24", name: "Orphelin", siteId: null }, db);
  createSite({ name: "Site vide" }, db);
  const t = getReport("sites", db).tables[0];
  const nIdx = col(t, "networks");
  assert.equal(t.rows.reduce((a, r) => a + (r[nIdx] as number), 0), t.footer![nIdx]);
  const rows = t.rows;
  assert.ok(rows.some((r) => r[0] === null), "ligne Sans site");
  const empty = rows.find((r) => r[0] === "Site vide")!;
  assert.equal(empty[nIdx], 0);
  assert.equal(empty[col(t, "capacity")], null, "pas de réseau IPv4 : pas de capacité");
  assert.equal(displayCell(t, 0, rows.find((r) => r[0] === null)!, fr, "fr"), "Sans site");
  assert.equal(displayCell(t, 0, rows.find((r) => r[0] === null)!, en, "en"), "No site");
  const cap = t.rows.reduce((a, r) => a + ((r[col(t, "capacity")] as number | null) ?? 0), 0);
  assert.equal(cap, t.footer![col(t, "capacity")]);
});

test("rapports : réseaux — IPv6 sans capacité ni occupation, IPv4 : libres = capacité - utilisées - réservées", () => {
  const db = freshDb();
  const t = getReport("networks", db).tables[0];
  assert.equal(t.rows.length, listNetworks({}, db).length);
  const ci = col(t, "cidr");
  for (const row of t.rows) {
    const v6 = String(row[ci]).includes(":");
    if (v6) {
      assert.equal(row[col(t, "capacity")], null);
      assert.equal(row[col(t, "free")], null);
      assert.equal(row[col(t, "occupancy")], null);
    } else {
      const cap = row[col(t, "capacity")] as number;
      assert.equal(row[col(t, "free")], Math.max(0, cap - (row[col(t, "used")] as number) - (row[col(t, "reserved")] as number)));
      assert.ok((row[col(t, "occupancy")] as number) >= 0 && (row[col(t, "occupancy")] as number) <= 100);
    }
  }
});

test("rapports : DHCP — taille de plage et réservations", () => {
  const db = freshDb();
  const t = getReport("dhcp", db).tables[0];
  assert.ok(t.rows.length > 0);
  const total = (db.prepare("SELECT COUNT(*) AS c FROM dhcp_reservations").get() as { c: number }).c;
  assert.equal(t.footer![col(t, "reservations")], total);
  for (const row of t.rows) {
    const size = row[col(t, "poolSize")] as number;
    assert.ok(size >= 1, "une plage contient au moins une adresse");
  }
  const scope = db.prepare("SELECT range_start, range_end FROM dhcp_scopes ORDER BY id LIMIT 1").get() as { range_start: string; range_end: string };
  const last = (s: string) => Number(s.split(".")[3]);
  assert.equal(t.rows[0][col(t, "poolSize")], last(scope.range_end) - last(scope.range_start) + 1);
});

test("rapports : VLANs — un VLAN utilisé mais non défini est signalé", () => {
  const db = freshDb();
  createNetwork({ cidr: "172.20.0.0/24", name: "VLAN fantôme", siteId: null, vlan: 3999 }, db);
  const t = getReport("vlans", db).tables[0];
  const ghost = t.rows.find((r) => r[col(t, "number")] === 3999)!;
  assert.ok(ghost, "ligne du VLAN 3999");
  assert.equal(ghost[col(t, "defined")], false);
  assert.equal(ghost[col(t, "name")], null);
  assert.equal(ghost[col(t, "cidrs")], "172.20.0.0/24");
  assert.equal(displayCell(t, col(t, "defined"), ghost, fr, "fr"), "Non");
  const defined = t.rows.filter((r) => r[col(t, "defined")] === true);
  assert.ok(defined.length > 0);
});

test("rapports : VRF — la table globale n'apparaît que si des réseaux n'ont pas de VRF ; la somme des réseaux est conservée", () => {
  const db = freshDb();
  const t = getReport("vrf", db).tables[0];
  const total = t.rows.reduce((a, r) => a + (r[col(t, "networks")] as number), 0);
  assert.equal(total, listNetworks({}, db).length);
  const global = t.rows.find((r) => r[0] === null);
  if (global) assert.equal(displayCell(t, 0, global, fr, "fr"), "Globale");
});

test("rapports : un projet vide donne des tableaux vides, sans erreur", () => {
  const db = freshDb();
  const p = createProject({ name: "Vide" }, db);
  activateProject(p.id, db);
  for (const kind of REPORT_KINDS) {
    const r = getReport(kind, db);
    assert.equal(r.project, "Vide");
  }
  assert.equal(getReport("networks", db).tables[0].rows.length, 0);
  const totals = getReport("summary", db).tables[0];
  assert.equal(totals.rows.find((r) => r[0] === "networks")![1], 0);
  assert.equal(totals.rows.find((r) => r[0] === "v4Occupancy")![1], null, "pas de division par zéro");
});

test("rapports : mise en forme FR/EN (pourcentage, entiers, bail, oui/non) et CSV brut", () => {
  const db = freshDb();
  const sum = getReport("summary", db).tables[0];
  const occ = sum.rows.find((r) => r[0] === "v4Occupancy")!;
  const pctFr = displayCell(sum, 1, occ, fr, "fr");
  const pctEn = displayCell(sum, 1, occ, en, "en");
  assert.match(pctFr, /^\d+,\d%$/);
  assert.match(pctEn, /^\d+\.\d%$/);
  assert.equal(displayCell(sum, 0, occ, fr, "fr"), "Occupation IPv4");
  assert.equal(displayCell(sum, 0, occ, en, "en"), "IPv4 usage");
  // CSV : nombre brut arrondi à 0,1, pas de « % » ni de séparateur de milliers
  assert.equal(typeof csvCell(sum, 1, occ, fr), "number");
  const cap = sum.rows.find((r) => r[0] === "v4Capacity")!;
  assert.equal(csvCell(sum, 1, cap, fr), cap[1]);

  const dh = getReport("dhcp", db).tables[0];
  assert.match(displayCell(dh, col(dh, "lease"), dh.rows[0], fr, "fr"), /\b(j|h|min|s)\b/);
  assert.equal(displayCell(dh, col(dh, "enabled"), [...dh.rows[0]].map((c, i) => (i === col(dh, "enabled") ? true : c)), en, "en"), "Yes");
});

test("rapports : le CSV d'un rapport se relit tel quel (aller-retour) et protège les formules", () => {
  const db = freshDb();
  createSite({ name: "=cmd|calc" }, db);
  const t = getReport("sites", db).tables[0];
  const header = t.columns.map((c) => (fr.reports.columns as Record<string, string>)[c.key]);
  const rows = t.rows.map((row) => row.map((_, i) => csvCell(t, i, row, fr)));
  const text = toCsv(header, rows, ";");
  const back = parseCsv(text, ";");
  assert.equal(back.length, rows.length + 1);
  assert.deepEqual(back[0], header);
  assert.ok(back.some((r) => r[0] === "=cmd|calc"), "la cellule est restituée sans apostrophe");
  assert.ok(text.includes("'=cmd|calc"), "mais protégée dans le fichier");
});
