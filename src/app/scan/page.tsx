import { currentUser, requireUser } from "@/lib/auth/guard";
import { listNetworks } from "@/lib/db/queries";
import { scanAllowsPublic } from "@/lib/db/scans";
import { scanRefusal } from "@/lib/scan/targets";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { ScanView } from "@/components/scan/ScanView";

export const dynamic = "force-dynamic";

/** Scan réseau : lecture pour tous, lancement à partir du rôle éditeur. */
export default function ScanPage() {
  requireUser("viewer");
  const user = currentUser();
  const { t } = getDictionary();
  const nets = listNetworks({}).filter((n) => scanRefusal(n.cidr, scanAllowsPublic()) === null).map((n) => ({ id: n.id, cidr: n.cidr, name: n.name }));
  return (
    <>
      <PageHeader title={t.scan.title} subtitle={t.scan.subtitle} />
      <ScanView networks={nets} canScan={!user || user.role !== "viewer"} />
    </>
  );
}
