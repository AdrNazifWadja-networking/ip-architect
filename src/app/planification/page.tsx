import { requireUser } from "@/lib/auth/guard";
import { listPlans } from "@/lib/db/planning";
import { listVrfs } from "@/lib/db/vrf";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { PlansView } from "@/components/planning/PlansView";

export const dynamic = "force-dynamic";

export default function PlanificationPage() {
  requireUser();
  const { t } = getDictionary();
  const vrfs = listVrfs().map((v) => ({ id: v.id, name: v.name }));
  return (
    <>
      <PageHeader title={t.planning.title} subtitle={t.planning.subtitle} />
      <PlansView plans={listPlans()} vrfs={vrfs} />
    </>
  );
}
