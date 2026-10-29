/**
 * Secours : (re)crée un compte ADMINISTRATEUR actif et fixe son mot de passe. À lancer sur le serveur, base arrêtée ou non.
 *
 *   npm run user:reset -- <identifiant> [mot-de-passe]
 *
 * Sans mot de passe, un mot de passe aléatoire est généré et affiché une seule fois. Le compte existant garde son nom
 * affiché ; ses sessions en cours sont fermées. Passer un mot de passe en argument le laisse dans l'historique du shell :
 * préférez le laisser être généré, puis changez-le dans « Mon compte ».
 */
import { randomBytes } from "node:crypto";

async function main() {
  const [rawName, given] = process.argv.slice(2);
  if (!rawName) {
    console.error("Usage : npm run user:reset -- <identifiant> [mot-de-passe]");
    process.exit(2);
  }
  const { getDb } = await import("../src/lib/db");
  const { createUser, getUser, normalizeUsername, updateUser } = await import("../src/lib/db/users");
  const db = getDb();
  const username = normalizeUsername(rawName);
  const password = given ?? randomBytes(12).toString("base64url");
  const row = db.prepare("SELECT id FROM users WHERE LOWER(username) = ?").get(username) as { id: number } | undefined;
  if (row) {
    // actorId = null : opération d'exploitation, pas d'utilisateur connecté (les garde-fous « soi-même » ne s'appliquent pas)
    await updateUser(row.id, { role: "admin", active: true, password }, null, db);
    console.log(`Compte « ${getUser(row.id, db).username} » réinitialisé : administrateur actif, sessions fermées.`);
  } else {
    await createUser({ username, displayName: username, password, role: "admin" }, db);
    console.log(`Compte administrateur « ${username} » créé.`);
  }
  if (!given) console.log(`Mot de passe : ${password}`);
  console.log("La connexion est maintenant exigée pour accéder à l'application.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
