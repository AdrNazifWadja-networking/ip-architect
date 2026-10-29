/**
 * Réinitialise la base SQLite avec les données de démonstration.
 * Usage : npm run seed
 */
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "ip-architect.db");

for (const suffix of ["", "-wal", "-shm"]) {
  const file = dbPath + suffix;
  if (fs.existsSync(file)) fs.rmSync(file);
}

// getDb() recrée le schéma et injecte les données de démo car la base est vide.
import("../src/lib/db").then(({ getDb }) => {
  const db = getDb();
  const n = (db.prepare("SELECT COUNT(*) AS c FROM networks").get() as { c: number }).c;
  console.log(`Base réinitialisée : ${dbPath} (${n} réseaux)`);
});
