import { requireUser } from "@/lib/auth/guard";
import { getMonitoring } from "@/lib/db/monitoring";
import { listNetworks } from "@/lib/db/queries";
import { countInventoried } from "@/lib/db/ipam";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { MonitoringView } from "@/components/monitoring/MonitoringView";

export const dynamic = "force-dynamic";

/** Nombre de réseaux montrés dans le tableau d'occupation (les plus occupés d'abord). */
const CAPACITY_SHOWN = 15;

export default function SupervisionPage() {
  requireUser();
  const { t } = getDictionary();
  const data = getMonitoring();
  const inventoried = countInventoried();
  const probeNetworks = listNetworks()
    .filter((n) => (inventoried.get(n.id) ?? 0) > 0)
    .map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, inventoried: inventoried.get(n.id) ?? 0 }));
  const capacityHidden = Math.max(0, data.capacity.length - CAPACITY_SHOWN);
  return (
    <>
      <PageHeader title={t.monitoring.title} subtitle={t.monitoring.subtitle} />
      <MonitoringView data={{ ...data, capacity: data.capacity.slice(0, CAPACITY_SHOWN) }} probeNetworks={probeNetworks} capacityHidden={capacityHidden} />
    </>
  );
}
