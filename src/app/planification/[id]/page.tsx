import { requireUser } from "@/lib/auth/guard";
import { notFound } from "next/navigation";
import { getPlan } from "@/lib/db/planning";
import { listSites } from "@/lib/db/queries";
import { ApiError, type PlanDetail } from "@/lib/types";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { PlanEditor } from "@/components/planning/PlanEditor";

export const dynamic = "force-dynamic";

function loadPlan(id: number): PlanDetail | null {
  try {
    return getPlan(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export default async function PlanDetailPage(props: { params: Promise<{ id: string }> }) {
  requireUser();
  const params = await props.params;
  const { t } = getDictionary();
  const id = /^\d+$/.test(params.id) ? Number(params.id) : NaN;
  const plan = Number.isInteger(id) ? loadPlan(id) : null;
  if (!plan) notFound();
  const sites = listSites().map((s) => ({ id: s.id, name: s.name }));
  return (
    <>
      <PageHeader title={plan.name} subtitle={t.planning.subtitle} />
      <PlanEditor key={`${plan.id}-${plan.status}-${plan.items.length}`} plan={plan} sites={sites} />
    </>
  );
}
