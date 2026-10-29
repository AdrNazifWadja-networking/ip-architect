import { requireUser } from "@/lib/auth/guard";
import { exportCounts, ENTITY_SPECS } from "@/lib/db/csvio";
import { getDictionary } from "@/lib/i18n/server";
import { CSV_ENTITIES, type CsvEntity } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { ImportExportView } from "@/components/importexport/ImportExportView";

export const dynamic = "force-dynamic";

export default function ImportExportPage() {
  requireUser();
  const { t } = getDictionary();
  const specs = Object.fromEntries(
    CSV_ENTITIES.map((e) => [e, { header: [...ENTITY_SPECS[e].header], required: [...ENTITY_SPECS[e].required] }]),
  ) as Record<CsvEntity, { header: string[]; required: string[] }>;
  return (
    <>
      <PageHeader title={t.importExport.title} subtitle={t.importExport.subtitle} />
      <ImportExportView counts={exportCounts()} specs={specs} />
    </>
  );
}
