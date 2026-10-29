import { requireUser } from "@/lib/auth/guard";
import { countGlobalNetworks, listVrfs } from "@/lib/db/vrf";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { VrfView } from "@/components/vrf/VrfView";

export const dynamic = "force-dynamic";

export default async function VrfPage(props: { searchParams: Promise<{ q?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const q = searchParams.q?.trim() ?? "";
  return (
    <>
      <PageHeader title={t.vrf.title} subtitle={t.vrf.subtitle} />
      <VrfView vrfs={listVrfs({ q })} globalCount={countGlobalNetworks()} q={q} />
    </>
  );
}
