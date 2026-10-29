import { requireUser } from "@/lib/auth/guard";
import { listNetworks } from "@/lib/db/queries";
import { listVrfs } from "@/lib/db/vrf";
import { isSimMode, type SimMode } from "@/lib/db/simulator";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { SimulatorView } from "@/components/simulator/SimulatorView";

export const dynamic = "force-dynamic";

export default async function SimulateurPage(props: { searchParams: Promise<{ mode?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const mode: SimMode = isSimMode(searchParams.mode) ? searchParams.mode : "split";
  const networks = listNetworks().map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, vrfName: n.vrfName }));
  const vrfs = listVrfs().map((v) => ({ id: v.id, name: v.name }));
  return (
    <>
      <PageHeader title={t.simulator.title} subtitle={t.simulator.subtitle} />
      <SimulatorView initialMode={mode} networks={networks} vrfs={vrfs} />
    </>
  );
}
