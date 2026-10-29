/** Export CSV du journal d'audit : libellés dans la langue de l'utilisateur, dates en UTC (ISO 8601). */
import type { Dictionary } from "./i18n";
import { toCsv, type Delimiter } from "./csv/csv";
import type { AuditRow } from "./auditTypes";
import { changesSummary } from "./changeTypes";

export function auditCsv(rows: AuditRow[], t: Dictionary, delimiter: Delimiter = ";"): string {
  const c = t.audit.columns;
  const header = [c.at, c.user, c.action, c.entity, c.detail, c.project, c.ip, c.via, c.changes];
  const body = rows.map((r) => [
    r.at,
    r.username,
    t.audit.actions[r.action],
    t.audit.entities[r.entity],
    r.detail,
    r.projectName,
    r.ip,
    r.via ? r.via.replace(/^token:/, "") : null,
    changesSummary(r.changes) || null,
  ]);
  return toCsv(header, body, delimiter);
}
