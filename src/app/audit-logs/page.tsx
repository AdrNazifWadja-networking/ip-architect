import { requireUser } from "@/lib/auth/guard";
import { listAudit, listAuditUsers } from "@/lib/db/audit";
import { getAuditRetentionDays } from "@/lib/db/appsettings";
import { auditFiltersFrom } from "@/lib/auditFilters";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { AuditView } from "@/components/audit/AuditView";

export const dynamic = "force-dynamic";

export default async function AuditLogsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireUser("admin");
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const filters = auditFiltersFrom((k) => {
    const v = searchParams[k];
    return Array.isArray(v) ? v[0] : v;
  });
  return (
    <>
      <PageHeader title={t.audit.title} subtitle={t.audit.subtitle} />
      <AuditView data={listAudit(filters)} filters={filters} users={listAuditUsers()} retentionDays={getAuditRetentionDays()} />
    </>
  );
}
