import { requireUser } from "@/lib/auth/guard";
import { getReport } from "@/lib/db/reports";
import { isReportKind, type ReportKind } from "@/lib/reportTypes";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { ReportView } from "@/components/reports/ReportView";

export const dynamic = "force-dynamic";

export default async function RapportsPage(props: { searchParams: Promise<{ type?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const kind: ReportKind = isReportKind(searchParams.type) ? searchParams.type : "summary";
  return (
    <>
      <PageHeader title={t.reports.title} subtitle={t.reports.subtitle} />
      <ReportView report={getReport(kind)} />
    </>
  );
}
