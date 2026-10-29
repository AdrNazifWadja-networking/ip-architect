import { requireUser } from "@/lib/auth/guard";
import { listNetworks, listSites } from "@/lib/db/queries";
import { listVrfs } from "@/lib/db/vrf";
import { listFields, listTags } from "@/lib/db/meta";
import type { NetworkStatus } from "@/lib/types";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { NetworksView } from "@/components/networks/NetworksView";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: { q?: string; status?: string; version?: string; vrf?: string; site?: string; tag?: string; nouveau?: string };
}

export default async function ReseauxPage(props: { searchParams: Promise<Props["searchParams"]> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const version = searchParams.version === "4" ? 4 : searchParams.version === "6" ? 6 : undefined;
  const status = (searchParams.status as NetworkStatus | undefined) || undefined;

  // ?vrf=none -> réseaux sans VRF ; ?vrf=3 -> VRF n° 3 ; autre valeur -> pas de filtre
  const vrf = searchParams.vrf === "none" ? "none" : searchParams.vrf && /^\d+$/.test(searchParams.vrf) ? Number(searchParams.vrf) : undefined;

  // ?site=4 -> réseaux du site n° 4 ; valeur inconnue ou invalide -> pas de filtre
  const sites = listSites();
  const siteParam = searchParams.site && /^\d+$/.test(searchParams.site) ? Number(searchParams.site) : undefined;
  const siteId = siteParam !== undefined && sites.some((s) => s.id === siteParam) ? siteParam : undefined;

  const networks = listNetworks({ q: searchParams.q, status, version, vrf, siteId, tag: searchParams.tag || undefined });
  const allTags = listTags().map((x) => ({ name: x.name, color: x.color }));
  const vrfs = listVrfs().map((v) => ({ id: v.id, name: v.name }));

  return (
    <>
      <PageHeader title={t.networks.title} subtitle={t.networks.subtitle} />
      <NetworksView
        networks={networks}
        sites={sites}
        vrfs={vrfs}
        allTags={allTags}
        fields={listFields("network")}
        initialOpen={searchParams.nouveau === "1"}
        filters={{ q: searchParams.q ?? "", status: status ?? "", version: version ? String(version) : "", vrf: vrf === undefined ? "" : String(vrf), site: siteId === undefined ? "" : String(siteId), tag: searchParams.tag ?? "" }}
      />
    </>
  );
}
