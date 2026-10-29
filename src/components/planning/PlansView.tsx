"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { PlanRow } from "@/lib/types";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { PlanForm } from "./PlanForm";

interface Props {
  plans: PlanRow[];
  vrfs: { id: number; name: string }[];
}

export function PlansView({ plans, vrfs }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const p = t.planning;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // date en UTC : le serveur et le navigateur affichent la même chose (pas d'écart d'hydratation)
  const day = (iso: string) => new Date(iso).toLocaleDateString(INTL_TAG[locale], { timeZone: "UTC" });

  const remove = async (plan: PlanRow) => {
    if (!window.confirm(format(p.deleteConfirm, { name: plan.name }))) return;
    setBusy(plan.id);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${plan.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? p.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : p.deleteFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center">
        <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {p.newPlan}
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{p.columns.name}</th>
              <th className="px-4 py-3 font-medium">{p.columns.block}</th>
              <th className="px-4 py-3 font-medium">{p.columns.vrf}</th>
              <th className="px-4 py-3 font-medium">{p.columns.networks}</th>
              <th className="px-4 py-3 font-medium">{p.columns.status}</th>
              <th className="px-4 py-3 font-medium">{p.columns.created}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {plans.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted">
                  {p.empty}
                </td>
              </tr>
            )}
            {plans.map((plan) => (
              <tr key={plan.id} className="hover:bg-panel2/60">
                <td className="px-4 py-3">
                  <Link href={`/planification/${plan.id}`} aria-label={format(p.openLabel, { name: plan.name })} className="font-semibold text-fg hover:text-brand-soft">
                    {plan.name}
                  </Link>
                  {plan.description && <div className="text-xs text-muted">{plan.description}</div>}
                </td>
                <td className="px-4 py-3 font-mono text-fg2">{plan.parentCidr}</td>
                <td className="px-4 py-3 text-fg2">{plan.vrfName ?? p.globalVrf}</td>
                <td className="px-4 py-3 text-fg2">{plan.itemCount}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      plan.status === "applied" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"
                    }`}
                  >
                    {p.statuses[plan.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted">{day(plan.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => remove(plan)}
                    disabled={busy === plan.id}
                    aria-label={format(p.deleteLabel, { name: plan.name })}
                    className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">{format(p.shown, { n: plans.length })}</p>
      <p className="mt-1 text-xs text-muted">{p.note}</p>

      {open && <PlanForm vrfs={vrfs} onClose={() => setOpen(false)} />}
    </>
  );
}
