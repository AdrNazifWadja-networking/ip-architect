import { currentUser, requireUser } from "@/lib/auth/guard";
import { listNetworks } from "@/lib/db/queries";
import { getTopology } from "@/lib/db/topology";
import { scanAllowsPublic } from "@/lib/db/scans";
import { scanRefusal } from "@/lib/scan/targets";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { TopologyView } from "@/components/topology/TopologyView";

export const dynamic = "force-dynamic";

/** Topologie réseau : lecture pour tous, édition et découverte à partir du rôle éditeur, identifiants SNMP pour l'administrateur. */
export default function TopologyPage() {
  requireUser("viewer");
  const user = currentUser();
  const { t } = getDictionary();
  const nets = listNetworks({}).filter((n) => scanRefusal(n.cidr, scanAllowsPublic()) === null).map((n) => ({ id: n.id, cidr: n.cidr, name: n.name }));
  return (
    <>
      <PageHeader title={t.topology.title} subtitle={t.topology.subtitle} />
      <TopologyView initial={getTopology()} networks={nets} canEdit={!user || user.role !== "viewer"} isAdmin={!user || user.role === "admin"} />
    </>
  );
}
