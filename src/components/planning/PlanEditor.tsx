"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import type { NetworkStatus, PlanDetail, PlanItemInput } from "@/lib/types";
import { allocatePlan, type PlanNeed } from "@/lib/plan/plan";
import { cidrBlock, blockSize, freeBlocks } from "@/lib/plan/blocks";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { formatCount } from "@/lib/format";

interface Props {
  plan: PlanDetail;
  sites: { id: number; name: string }[];
}

interface Row {
  /** Clé stable pour React (jamais envoyée au serveur). */
  key: number;
  name: string;
  kind: "hosts" | "prefix";
  value: string;
  siteId: string;
  vlan: string;
}

const STATUSES: NetworkStatus[] = ["inactive", "active", "maintenance", "error"];

/** Entier strictement décimal, sinon null (« 12abc », « 1.5 » et « » sont refusés). */
function toInt(s: string): number | null {
  return /^\d+$/.test(s.trim()) ? Number(s.trim()) : null;
}

function toNeed(r: Row): PlanNeed {
  const n = toInt(r.value);
  return r.kind === "hosts" ? { hosts: n, prefix: null } : { hosts: null, prefix: n };
}

function toInput(r: Row): PlanItemInput {
  const n = toInt(r.value);
  return {
    name: r.name,
    hosts: r.kind === "hosts" ? n : null,
    prefix: r.kind === "prefix" ? n : null,
    siteId: r.siteId === "" ? null : Number(r.siteId),
    vlan: r.vlan.trim() === "" ? null : toInt(r.vlan),
  };
}

export function PlanEditor({ plan, sites }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const d = t.planning.detail;
  const applied = plan.status === "applied";

  let nextKey = 0;
  const initialRows = (): Row[] =>
    plan.items.map((i) => ({
      key: nextKey++,
      name: i.name,
      kind: i.prefix !== null ? "prefix" : "hosts",
      value: String(i.prefix ?? i.hosts ?? ""),
      siteId: i.siteId === null ? "" : String(i.siteId),
      vlan: i.vlan === null ? "" : String(i.vlan),
    }));

  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? "");
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [counter, setCounter] = useState(plan.items.length);
  const [applyStatus, setApplyStatus] = useState<NetworkStatus>("inactive");
  const [busy, setBusy] = useState<"save" | "apply" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // état enregistré : sert à savoir s'il y a des modifications non enregistrées
  const savedSnapshot = useMemo(
    () =>
      JSON.stringify([
        plan.name,
        plan.description ?? "",
        plan.items.map((i) => [i.name, i.hosts, i.prefix, i.siteId, i.vlan]),
      ]),
    [plan],
  );
  const currentSnapshot = JSON.stringify([
    name,
    description.trim(),
    rows.map((r) => {
      const x = toInput(r);
      return [x.name, x.hosts ?? null, x.prefix ?? null, x.siteId ?? null, x.vlan ?? null];
    }),
  ]);
  const dirty = !applied ? savedSnapshot !== currentSnapshot : name !== plan.name || description.trim() !== (plan.description ?? "");

  // aperçu en direct : même calcul que celui du serveur à l'application du plan
  const allocation = useMemo(() => allocatePlan(plan.parentCidr, plan.taken, rows.map(toNeed)), [plan.parentCidr, plan.taken, rows]);
  const placed = allocation.filter((a) => a.cidr !== null);
  const freeAddresses = useMemo(() => {
    const blocks = freeBlocks(plan.parentCidr, [...plan.taken, ...placed.map((a) => a.cidr as string)]);
    return blocks.reduce((sum, c) => sum + blockSize(cidrBlock(c)!), 0n);
  }, [plan.parentCidr, plan.taken, placed]);

  const update = (key: number, patch: Partial<Row>) => {
    setNotice(null);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const add = () => {
    setNotice(null);
    setRows((rs) => [...rs, { key: 1000 + counter, name: "", kind: "hosts", value: "", siteId: "", vlan: "" }]);
    setCounter((c) => c + 1);
  };
  const remove = (key: number) => {
    setNotice(null);
    setRows((rs) => rs.filter((r) => r.key !== key));
  };

  const call = async (url: string, init: RequestInit, fallback: string): Promise<boolean> => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? fallback);
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      return false;
    }
  };

  const save = async () => {
    setBusy("save");
    const body = applied
      ? { name, description: description.trim() || null }
      : { name, description: description.trim() || null, items: rows.map(toInput) };
    const ok = await call(`/api/plans/${plan.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, d.saveFailed);
    setBusy(null);
    if (ok) {
      setNotice(d.saved);
      router.refresh();
    }
  };

  const allPlaced = rows.length > 0 && placed.length === rows.length;
  const canApply = !applied && allPlaced && !dirty;

  const apply = async () => {
    if (!window.confirm(format(d.applyConfirm, { n: rows.length, block: plan.parentCidr }))) return;
    setBusy("apply");
    const ok = await call(`/api/plans/${plan.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: applyStatus }) }, d.applyFailed);
    setBusy(null);
    if (ok) router.refresh();
  };

  const removePlan = async () => {
    if (!window.confirm(format(t.planning.deleteConfirm, { name: plan.name }))) return;
    setBusy("delete");
    const ok = await call(`/api/plans/${plan.id}`, { method: "DELETE" }, t.planning.deleteFailed);
    if (ok) router.push("/planification");
    else setBusy(null);
  };

  const resultLabel = (i: number): { text: string; tone: string } => {
    if (applied) return { text: d.results.applied, tone: "text-ok" };
    const a = allocation[i];
    if (a.cidr !== null) return { text: d.results.ok, tone: "text-ok" };
    const key = a.reason === "noSpace" ? "noSpace" : a.reason === "tooBig" ? "tooBig" : "invalid";
    return { text: d.results[key], tone: "text-bad" };
  };

  const created = new Date(plan.createdAt).toLocaleDateString(INTL_TAG[locale], { timeZone: "UTC" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/planification" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
          {d.back}
        </Link>
        <button type="button" onClick={removePlan} disabled={busy !== null} className="btn-ghost ml-auto h-8 px-3 text-xs text-bad">
          <Trash2 className="h-4 w-4" />
          {d.deleteLabel}
        </button>
      </div>

      <section className="card grid gap-4 p-5 lg:grid-cols-4">
        <div>
          <div className="label-caps">{d.block}</div>
          <div className="mt-1 font-mono text-fg">{plan.parentCidr}</div>
        </div>
        <div>
          <div className="label-caps">{d.vrf}</div>
          <div className="mt-1 text-fg">{plan.vrfName ?? t.planning.globalVrf}</div>
        </div>
        <div>
          <div className="label-caps">{d.state}</div>
          <div className="mt-1">
            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${applied ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>
              {t.planning.statuses[plan.status]}
            </span>
            <span className="ml-2 text-xs text-muted">{created}</span>
          </div>
        </div>
        <div />
        <div className="lg:col-span-2">
          <label className="label-caps mb-1.5 block" htmlFor="plan-title">
            {d.rename}
          </label>
          <input id="plan-title" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </div>
        <div className="lg:col-span-2">
          <label className="label-caps mb-1.5 block" htmlFor="plan-description">
            {d.description}
          </label>
          <input id="plan-description" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </div>
      </section>

      {applied && <p className="rounded-md border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{d.appliedNote}</p>}

      <section className="card overflow-x-auto" aria-labelledby="plan-items-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id="plan-items-title" className="card-title">
            {d.itemsTitle}
          </h2>
          {!applied && (
            <button type="button" onClick={add} className="btn-ghost h-8 px-3 text-xs">
              <Plus className="h-4 w-4" />
              {d.add}
            </button>
          )}
        </div>
        {!applied && <p className="border-b border-line px-5 py-3 text-xs text-muted">{d.help}</p>}

        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">{d.columns.name}</th>
              <th className="px-4 py-3 font-medium">{d.columns.need}</th>
              <th className="px-4 py-3 font-medium">{d.columns.site}</th>
              <th className="px-4 py-3 font-medium">{d.columns.vlan}</th>
              <th className="px-4 py-3 font-medium">{d.columns.block}</th>
              <th className="px-4 py-3 font-medium">{d.columns.usable}</th>
              <th className="px-4 py-3 font-medium">{d.columns.result}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-muted">
                  {d.noItems}
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              const n = i + 1;
              const res = resultLabel(i);
              const item = plan.items[i];
              const shownCidr = applied ? item?.appliedCidr : allocation[i].cidr;
              return (
                <tr key={r.key}>
                  <td className="px-4 py-2.5">
                    {applied ? (
                      <span className="font-medium text-fg">{r.name}</span>
                    ) : (
                      <input
                        aria-label={`${d.columns.name} ${n}`}
                        value={r.name}
                        maxLength={80}
                        onChange={(e) => update(r.key, { name: e.target.value })}
                        placeholder={d.namePlaceholder}
                        className="input"
                      />
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {applied ? (
                      <span className="text-fg2">
                        {r.kind === "hosts" ? `${d.needKinds.hosts} ${r.value}` : `${d.needKinds.prefix} /${r.value}`}
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={format(d.needKindLabel, { n })}
                          value={r.kind}
                          onChange={(e) => update(r.key, { kind: e.target.value as Row["kind"] })}
                          className="input w-28"
                        >
                          <option value="hosts">{d.needKinds.hosts}</option>
                          <option value="prefix">{d.needKinds.prefix}</option>
                        </select>
                        <input
                          aria-label={format(d.needValueLabel, { n })}
                          inputMode="numeric"
                          value={r.value}
                          onChange={(e) => update(r.key, { value: e.target.value })}
                          className="input w-24 font-mono"
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {applied ? (
                      <span className="text-fg2">{item?.siteName ?? d.noSite}</span>
                    ) : (
                      <select aria-label={`${d.columns.site} ${n}`} value={r.siteId} onChange={(e) => update(r.key, { siteId: e.target.value })} className="input w-44">
                        <option value="">{d.noSite}</option>
                        {sites.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {applied ? (
                      <span className="text-fg2">{item?.vlan ?? d.noSite}</span>
                    ) : (
                      <input
                        aria-label={`${d.columns.vlan} ${n}`}
                        inputMode="numeric"
                        value={r.vlan}
                        onChange={(e) => update(r.key, { vlan: e.target.value })}
                        className="input w-20 font-mono"
                      />
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-fg">{shownCidr ?? "—"}</td>
                  <td className="px-4 py-2.5 text-fg2">{applied || allocation[i].usable === null ? "—" : formatCount(allocation[i].usable as bigint, locale)}</td>
                  <td className={`px-4 py-2.5 font-medium ${res.tone}`}>{res.text}</td>
                  <td className="px-4 py-2.5 text-right">
                    {!applied && (
                      <button
                        type="button"
                        onClick={() => remove(r.key)}
                        aria-label={format(d.removeLabel, { n })}
                        className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {!applied && rows.length > 0 && (
        <p className="text-sm text-fg2" role="status">
          {format(d.summary, { placed: placed.length, total: rows.length, free: formatCount(freeAddresses, locale) })}
        </p>
      )}

      <section className="card p-5" aria-labelledby="plan-taken-title">
        <h2 id="plan-taken-title" className="card-title mb-3">
          {d.takenTitle}
        </h2>
        {plan.taken.length === 0 ? (
          <p className="text-sm text-muted">{d.takenNone}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {plan.taken.map((c) => (
              <li key={c} className="rounded-md border border-line bg-panel2 px-2.5 py-1 font-mono text-xs text-fg2">
                {c}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy !== null || !dirty || name.trim() === ""} className="btn-primary">
          {busy === "save" ? d.saving : d.save}
        </button>
        {dirty && <span className="text-xs text-warn">{d.unsaved}</span>}

        {applied ? (
          <Link href="/reseaux" className="btn-ghost ml-auto">
            {d.viewNetworks}
          </Link>
        ) : (
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              {d.applyStatus}
              <select value={applyStatus} onChange={(e) => setApplyStatus(e.target.value as NetworkStatus)} className="input h-9 w-40">
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t.status[s]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={apply} disabled={busy !== null || !canApply} className="btn-primary">
              {busy === "apply" ? d.applying : d.apply}
            </button>
          </div>
        )}
      </div>
      {!applied && !canApply && rows.length > 0 && (
        <p className="text-xs text-muted">{dirty ? d.applyNeedsSave : !allPlaced ? d.applyBlocked : ""}</p>
      )}
    </div>
  );
}
