import { requireUser } from "@/lib/auth/guard";
import { listVlans } from "@/lib/db/ipam";
import { listSites } from "@/lib/db/queries";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { VlansView } from "@/components/vlans/VlansView";

export const dynamic = "force-dynamic";

export default async function VlansPage(props: { searchParams: Promise<{ q?: string; site?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const siteId = searchParams.site && /^\d+$/.test(searchParams.site) ? Number(searchParams.site) : undefined;

  const vlans = listVlans({ q: searchParams.q, siteId });
  const sites = listSites();

  return (
    <>
      <PageHeader title={t.vlans.title} subtitle={t.vlans.subtitle} />
      <VlansView
        vlans={vlans}
        sites={sites}
        filters={{ q: searchParams.q ?? "", site: siteId !== undefined ? String(siteId) : "" }}
      />
    </>
  );
}
