import { requireUser } from "@/lib/auth/guard";
import { listSitesDetailed } from "@/lib/db/sites";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { SitesView } from "@/components/sites/SitesView";

export const dynamic = "force-dynamic";

export default async function SitesPage(props: { searchParams: Promise<{ q?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const q = searchParams.q?.trim() ?? "";
  return (
    <>
      <PageHeader title={t.sites.title} subtitle={t.sites.subtitle} />
      <SitesView sites={listSitesDetailed({ q })} q={q} />
    </>
  );
}
