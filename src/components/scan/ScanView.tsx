"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SCAN_DEFAULT_PORTS, SCAN_PORTS, SCHEDULE_HOURS, type ScanImportResult, type ScanReport, type ScanRowState, type ScanSchedule } from "@/lib/scanTypes";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

interface Net { id: number; cidr: string; name: string }

async function call<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data;
}

const BADGE: Record<ScanRowState, string> = {
  new: "border-brand/50 bg-brand/10 text-brand-soft",
  known: "border-ok/40 bg-ok/10 text-ok",
  silent: "border-warn/40 bg-warn/10 text-warn",
  ignored: "border-line bg-surface-2 text-muted",
};

export function ScanView({ networks, canScan }: { networks: Net[]; canScan: boolean }) {
  const { t, locale } = useI18n();
  const s = t.scan;
  const [netId, setNetId] = useState<number | "">(networks[0]?.id ?? "");
  const [icmp, setIcmp] = useState(true);
  const [ports, setPorts] = useState<number[]>([...SCAN_DEFAULT_PORTS]);
  const [resolve, setResolve] = useState(true);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [filter, setFilter] = useState<"all" | ScanRowState>("all");
  const [schedule, setSchedule] = useState<ScanSchedule | null>(null);
  const [every, setEvery] = useState<number>(24);
  const [sEnabled, setSEnabled] = useState(true);
  const [sAlert, setSAlert] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (id: number) => {
    const r = await call<ScanReport>(`/api/networks/${id}/scan`, "GET", undefined, s.failed);
    setReport(r);
    return r;
  }, [s.failed]);

  // suivi de l'avancement : une lecture par seconde tant que le scan tourne
  useEffect(() => {
    if (netId === "") { setReport(null); return; }
    let stop = false;
    const tick = async () => {
      try {
        const r = await load(netId);
        if (!stop && r.scan?.status === "running") timer.current = setTimeout(tick, 1000);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : s.failed);
      }
    };
    setPicked(new Set());
    setError(null);
    void tick();
    call<{ schedule: ScanSchedule | null }>(`/api/networks/${netId}/scan/schedule`, "GET", undefined, s.failed)
      .then((r) => { if (stop) return; setSchedule(r.schedule); if (r.schedule) { setEvery(r.schedule.everyHours); setSEnabled(r.schedule.enabled); setSAlert(r.schedule.alert); } })
      .catch(() => { if (!stop) setSchedule(null); });
    return () => { stop = true; if (timer.current) clearTimeout(timer.current); };
  }, [netId, load, s.failed]);

  const run = async (fn: () => Promise<string | null | void>) => {
    setBusy(true); setError(null); setInfo(null);
    try { const m = await fn(); if (m) setInfo(m); }
    catch (e) { setError(e instanceof Error ? e.message : s.failed); }
    finally { setBusy(false); }
  };

  const start = () => run(async () => {
    await call(`/api/networks/${netId}/scan`, "POST", { icmp, ports, resolve }, s.failed);
    const r = await load(netId as number);
    if (r.scan?.status === "running") timer.current = setTimeout(function again() {
      load(netId as number)
        .then((x) => { if (x.scan?.status === "running") timer.current = setTimeout(again, 1000); })
        .catch((e) => setError(e instanceof Error ? e.message : s.failed)); // jamais d'erreur non gérée : elle s'afficherait en plein écran
    }, 1000);
  });
  const cancel = () => run(async () => { await call(`/api/networks/${netId}/scan`, "DELETE", undefined, s.failed); });
  const saveSchedule = () => run(async () => {
    const r = await call<{ schedule: ScanSchedule }>(`/api/networks/${netId}/scan/schedule`, "PATCH", { everyHours: every, enabled: sEnabled, alert: sAlert, icmp, ports, resolve }, s.failed);
    setSchedule(r.schedule);
    return s.schedule.saved;
  });
  const removeSchedule = () => run(async () => {
    await call(`/api/networks/${netId}/scan/schedule`, "DELETE", undefined, s.failed);
    setSchedule(null);
    return s.schedule.removed;
  });
  const setIgnoredRows = (ignored: boolean) => run(async () => {
    const r = await call<{ changed: number }>(`/api/networks/${netId}/scan/ignore`, "POST", { addresses: [...picked], ignored }, s.failed);
    setPicked(new Set());
    await load(netId as number);
    return format(s.ignoredDone, { count: String(r.changed) });
  });
  const doImport = () => run(async () => {
    const r = await call<ScanImportResult>(`/api/networks/${netId}/scan/import`, "POST", { addresses: [...picked] }, s.failed);
    setPicked(new Set());
    await load(netId as number);
    return r.skipped > 0 ? format(s.importedSkipped, { count: String(r.imported), skipped: String(r.skipped) }) : format(s.imported, { count: String(r.imported) });
  });

  const rows = (report?.rows ?? []).filter((r) => filter === "all" || r.state === filter);
  const running = report?.scan?.status === "running";
  const toggle = (a: string) => setPicked((p) => { const n = new Set(p); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  const date = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-FR" : "en-GB");

  if (networks.length === 0) return <p className="card p-5 text-sm text-muted">{s.noNetworks}</p>;

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted">{s.intro}</p>
      {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
      {info && <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">{info}</div>}

      <section className="card space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="label-caps mb-1.5 block">{s.network}</span>
            <select className="input min-w-[260px]" value={netId} onChange={(e) => setNetId(e.target.value === "" ? "" : Number(e.target.value))} disabled={running}>
              <option value="">{s.choose}</option>
              {networks.map((n) => <option key={n.id} value={n.id}>{n.cidr} — {n.name}</option>)}
            </select>
          </label>
          {canScan && (
            <>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={icmp} onChange={(e) => setIcmp(e.target.checked)} />{s.icmp}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />{s.resolve}</label>
            </>
          )}
        </div>
        {canScan && (
          <div>
            <span className="label-caps mb-1.5 block">{s.ports}</span>
            <div className="flex flex-wrap gap-3">
              {SCAN_PORTS.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={ports.includes(p)} onChange={(e) => setPorts(e.target.checked ? [...ports, p] : ports.filter((x) => x !== p))} />
                  {p}
                </label>
              ))}
            </div>
            <span className="mt-1 block text-xs text-muted">{s.portsHint}</span>
          </div>
        )}
        {canScan && (
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || running || netId === ""} onClick={start}>{busy && !running ? s.starting : s.start}</button>
            {running && <button className="btn-secondary" disabled={busy} onClick={cancel}>{s.cancel}</button>}
          </div>
        )}
      </section>

      {report?.scan && (
        <section className="space-y-3" aria-live="polite">
          {running ? (
            <div>
              <div className="text-sm text-fg">{format(s.running, { done: String(report.scan.done), total: String(report.scan.total), alive: String(report.scan.alive) })}</div>
              <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded bg-surface-2"><div className="h-full bg-brand" style={{ width: `${report.scan.total ? (100 * report.scan.done) / report.scan.total : 0}%` }} /></div>
            </div>
          ) : (
            <>
              <div className="text-sm text-fg">{format(s.last, { date: date(report.scan.finishedAt ?? report.scan.startedAt), alive: String(report.scan.alive), total: String(report.scan.total) })}</div>
              {report.scan.status === "cancelled" && <div className="text-sm text-warn">{s.cancelled}</div>}
              {report.scan.notes.map((n) => <div key={n} className="text-sm text-warn">{(s.notes as Record<string, string>)[n] ?? n}</div>)}
              <div className="flex flex-wrap items-center gap-2">
                {(["all", "new", "known", "silent", "ignored"] as const).map((f) => (
                  <button key={f} className={filter === f ? "btn-primary" : "btn-secondary"} onClick={() => setFilter(f)} title={f === "all" ? undefined : s.stateHelp[f]}>
                    {s.filter[f]}{f !== "all" ? ` (${report.counts[f]})` : ` (${report.rows.length})`}
                  </button>
                ))}
                {canScan && (
                  <>
                    <button className="btn-secondary" onClick={() => setPicked(new Set(report.rows.filter((r) => r.state === "new").map((r) => r.address)))}>{s.selectNew}</button>
                    <button className="btn-primary" disabled={busy || picked.size === 0} onClick={doImport}>{busy ? s.importing : `${s.import} (${picked.size})`}</button>
                    <button className="btn-secondary" disabled={busy || picked.size === 0} onClick={() => setIgnoredRows(true)}>{s.ignore}</button>
                    {report.counts.ignored > 0 && (
                      <>
                        <button className="btn-secondary" onClick={() => setPicked(new Set(report.rows.filter((r) => r.state === "ignored").map((r) => r.address)))}>{s.selectIgnored}</button>
                        <button className="btn-secondary" disabled={busy || picked.size === 0} onClick={() => setIgnoredRows(false)}>{s.unignore}</button>
                      </>
                    )}
                  </>
                )}
              </div>
              {rows.length === 0 ? <p className="text-sm text-muted">{s.empty}</p> : (
                <div className="card overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted"><th className="w-8 px-3 py-2" /><th className="px-3 py-2">{s.cols.address}</th><th className="px-3 py-2">{s.cols.state}</th><th className="px-3 py-2">{s.cols.name}</th><th className="px-3 py-2">{s.cols.mac}</th><th className="px-3 py-2">{s.cols.via}</th><th className="px-3 py-2">{s.cols.ms}</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.address} className="border-t border-line">
                          <td className="px-3 py-2">{(r.state === "new" || r.state === "ignored") && canScan && <input type="checkbox" aria-label={r.address} checked={picked.has(r.address)} onChange={() => toggle(r.address)} />}</td>
                          <td className="px-3 py-2 font-mono">{r.address}</td>
                          <td className="px-3 py-2"><span className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${BADGE[r.state]}`} title={s.stateHelp[r.state]}>{s.states[r.state]}</span></td>
                          <td className="px-3 py-2">{r.hostname ?? ""}{r.discoveredHostname && r.discoveredHostname !== r.hostname && <span className="ml-2 text-xs text-muted">{format(s.nameDiscovered, { name: r.discoveredHostname })}</span>}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {r.mac ?? ""}
                            {r.prevMac && <span className="ml-2 rounded border border-warn/40 bg-warn/10 px-1 text-warn" title={format(s.macChanged, { mac: r.prevMac })}>≠ {r.prevMac}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted">{r.via.join(", ")}</td>
                          <td className="px-3 py-2 text-xs text-muted">{r.ms === null ? "" : `${r.ms} ms`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {report && !report.scan && netId !== "" && <p className="text-sm text-muted">{s.never}</p>}
      {report?.scan && !running && <p className="text-xs text-muted">{s.macHint}</p>}

      {netId !== "" && (
        <section className="card space-y-3 p-5" aria-label={s.schedule.title}>
          <h2 className="text-base font-bold text-fg">{s.schedule.title}</h2>
          <p className="max-w-3xl text-sm text-muted">{s.schedule.hint}</p>
          {!schedule && <p className="text-sm text-muted">{s.schedule.none}</p>}
          {schedule && (
            <p className="text-sm text-fg2">
              {schedule.lastStartedAt && <span className="mr-4">{format(s.schedule.last, { date: date(schedule.lastStartedAt) })}</span>}
              {schedule.enabled && (schedule.nextAt ? (Date.parse(schedule.nextAt) > Date.now() ? format(s.schedule.next, { date: date(schedule.nextAt) }) : s.schedule.soon) : s.schedule.soon)}
            </p>
          )}
          {canScan && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="label-caps mb-1.5 block">{s.schedule.every}</span>
                <select className="input" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  {SCHEDULE_HOURS.map((h) => <option key={h} value={h}>{(s.schedule.hours as Record<number, string>)[h]}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sEnabled} onChange={(e) => setSEnabled(e.target.checked)} />{s.schedule.enabled}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sAlert} onChange={(e) => setSAlert(e.target.checked)} />{s.schedule.alert}</label>
              <button className="btn-primary" disabled={busy || running} onClick={saveSchedule}>{busy ? s.schedule.saving : s.schedule.save}</button>
              {schedule && <button className="btn-secondary" disabled={busy} onClick={removeSchedule}>{s.schedule.remove}</button>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
