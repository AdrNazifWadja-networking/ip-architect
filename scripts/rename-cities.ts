/**
 * Une fois : renomme dans une base EXISTANTE les villes françaises des données de démonstration (Paris, Lyon, Marseille,
 * Strasbourg, Bordeaux) par des villes togolaises (Tchamba, Lomé, Sokodé, Kara, Atakpamé). Les nouvelles installations
 * reçoivent déjà ces noms ; une base existante garde les anciens. Ne touche que les noms exacts de la démonstration
 * (sites, suffixe des VLAN, noms d'hôtes générés) : tout ce que vous avez saisi vous-même reste intact. Relançable sans risque.
 *
 *   npm run rename:cities
 */
const CITIES = [
  { from: "Paris", to: "Tchamba", codeFrom: "par", codeTo: "tch" },
  { from: "Lyon", to: "Lomé", codeFrom: "lyo", codeTo: "lom" },
  { from: "Marseille", to: "Sokodé", codeFrom: "mar", codeTo: "sok" },
  { from: "Strasbourg", to: "Kara", codeFrom: "str", codeTo: "kar" },
  { from: "Bordeaux", to: "Atakpamé", codeFrom: "bor", codeTo: "ata" },
];

async function main() {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  let sites = 0, vlans = 0, hosts = 0;
  db.transaction(() => {
    for (const c of CITIES) {
      for (const prefix of ["Site Principal", "Datacenter", "Succursale", "Agence"]) {
        sites += db.prepare("UPDATE sites SET name = ? WHERE name = ?").run(`${prefix} - ${c.to}`, `${prefix} - ${c.from}`).changes as number;
      }
      vlans += db.prepare("UPDATE vlans SET name = SUBSTR(name, 1, LENGTH(name) - ?) || ? WHERE name LIKE ?").run(c.from.length, c.to, `% - ${c.from}`).changes as number;
      for (const [table, col] of [["ip_addresses", "hostname"], ["dhcp_reservations", "hostname"]] as const) {
        const rows = db.prepare(`SELECT rowid AS id, ${col} AS h FROM ${table} WHERE ${col} LIKE ?`).all(`%-${c.codeFrom}-%`) as { id: number; h: string }[];
        for (const r of rows) {
          const next = r.h.replace(`-${c.codeFrom}-`, `-${c.codeTo}-`);
          if (next !== r.h) hosts += db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(next, r.id).changes as number;
        }
      }
    }
  })();
  console.log(`Terminé : ${sites} site(s), ${vlans} VLAN, ${hosts} nom(s) d'hôte renommé(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
