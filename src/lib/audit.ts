/**
 * Écriture dans le journal d'audit depuis une route API (serveur seulement : lit la session et les en-têtes de la requête).
 *
 * `audit()` ne lève JAMAIS : si le journal est indisponible, l'action déjà réussie n'est pas annulée, l'erreur est tracée
 * dans la console du serveur. À appeler APRÈS le succès de l'opération.
 */
import { clientIpFrom } from "./auth/proxy";
import { syncHeaders as headers } from "@/lib/auth/nextHeaders";
import { getDb } from "./db";
import { auditLabel, recordAudit } from "./db/audit";
import { currentUser, requestAuth } from "./auth/guard";
import { trackChanges } from "./db/changes";
import type { ChangeSet } from "./changeTypes";
import type { AuditAction, AuditEntity } from "./auditTypes";

export { auditLabel, trackChanges };

export interface AuditCall {
  action: AuditAction;
  entity: AuditEntity;
  entityId?: number | null;
  /** Texte explicite ; sinon, le libellé de l'objet (auditLabel) est calculé. */
  detail?: string | null;
  /** Champs modifiés (clés du corps de la requête) : seuls les NOMS vont dans le détail ; les valeurs avant/après passent par `changes`. */
  fields?: unknown;
  /** Valeurs avant / après (voir `trackChanges`) : adressage et réglages non secrets uniquement. */
  changes?: ChangeSet | null;
  /** Acteur explicite (connexion : pas encore de session) ; undefined = utilisateur de la requête. */
  actor?: { id: number; username: string } | null;
  /** Nom saisi (échec de connexion). */
  username?: string | null;
}

export function clientIp(): string | null {
  try {
    return clientIpFrom((n) => headers().get(n));
  } catch {
    return null;
  }
}

/** « token:ipa_ab12 » si la requête s'authentifie par jeton d'API. */
function viaToken(): string | null {
  try {
    const t = requestAuth()?.token;
    return t ? `token:${t.prefix}` : null;
  } catch {
    return null;
  }
}

export function audit(call: AuditCall): void {
  try {
    const db = getDb();
    const actor = call.actor !== undefined ? call.actor : currentUser();
    let detail = call.detail ?? (call.entityId != null ? auditLabel(call.entity, call.entityId, db) : null);
    if (call.fields && typeof call.fields === "object" && !Array.isArray(call.fields)) {
      const names = Object.keys(call.fields).slice(0, 20).join(", ");
      if (names) detail = detail ? `${detail} · ${names}` : names;
    }
    recordAudit(
      {
        action: call.action,
        entity: call.entity,
        entityId: call.entityId ?? null,
        detail,
        userId: actor?.id ?? null,
        username: actor?.username ?? call.username ?? null,
        ip: clientIp(),
        changes: call.changes ?? null,
        via: viaToken(),
      },
      db,
    );
  } catch (e) {
    console.error("audit : écriture impossible", e);
  }
}
