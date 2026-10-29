import { requireUser } from "@/lib/auth/guard";
import { listScopes } from "@/lib/db/dhcp";
import { listNetworks } from "@/lib/db/queries";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { DhcpScopes } from "@/components/dhcp/DhcpScopes";

export const dynamic = "force-dynamic";

export default async function DhcpPage(props: { searchParams: Promise<{ q?: string; network?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const q = searchParams.q?.trim() ?? "";
  const scopes = listScopes({ q });
  const networks = listNetworks({})
    .filter((n) => n.version === 4)
    .map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, vrfName: n.vrfName }));
  const preselected = searchParams.network && /^\d+$/.test(searchParams.network) ? Number(searchParams.network) : null;

  return (
    <>
      <PageHeader title={t.dhcp.title} subtitle={t.dhcp.subtitle} />
      <DhcpScopes scopes={scopes} networks={networks} q={q} preselectedNetwork={preselected} />
    </>
  );
}
