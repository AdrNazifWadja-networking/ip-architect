import type { AuditFilters } from "./auditTypes";

/** Filtres du journal depuis une source de paramètres (URL ou searchParams d'une page). Les valeurs sont validées plus loin. */
export function auditFiltersFrom(get: (key: string) => string | null | undefined): AuditFilters {
  const page = get("page");
  const clean = (k: string) => {
    const v = get(k);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return {
    q: clean("q"),
    user: clean("user"),
    action: clean("action"),
    entity: clean("entity"),
    from: clean("from"),
    to: clean("to"),
    page: typeof page === "string" && /^\d{1,6}$/.test(page) ? Number(page) : undefined,
  };
}
