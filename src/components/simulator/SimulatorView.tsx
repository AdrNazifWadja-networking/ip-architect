"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import type { FitResult, FreeResult, MergeResult, SimMode, SplitResult } from "@/lib/db/simulator";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { formatCount } from "@/lib/format";

interface Props {
  initialMode: SimMode;
  networks: { id: number; cidr: string; name: string; vrfName: string | null }[];
  vrfs: { id: number; name: string }[];
}

const MODES: SimMode[] = ["split", "merge", "free", "fit"];

/** Entier décimal (texte, éventuellement énorme en IPv6) -> affichage localisé. */
const big = (s: string, locale: "fr" | "en") => formatCount(BigInt(s), locale);

export function SimulatorView({ initialMode, networks, vrfs }: Props) {
  const { t, locale } = useI18n();
  const s = t.simulator;
  const [mode, setMode] = useState<SimMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ mode: SimMode; data: unknown } | null>(null);

  // champs de chaque mode (un état par champ : on garde la saisie en changeant d'onglet)
  const [splitSource, setSplitSource] = useState<"existing" | "typed">(networks.length > 0 ? "existing" : "typed");
  const [splitNet, setSplitNet] = useState(networks[0] ? String(networks[0].id) : "");
  const [splitCidr, setSplitCidr] = useState("");
  const [splitPrefix, setSplitPrefix] = useState("");
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [mergeText, setMergeText] = useState("");
  const [freeParent, setFreeParent] = useState("");
  const [freeVrf, setFreeVrf] = useState("");
  const [freePrefix, setFreePrefix] = useState("");
  const [fitCidr, setFitCidr] = useState("");
  const [fitVrf, setFitVrf] = useState("");

  const numOrUndef = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const body = (): Record<string, unknown> => {
    switch (mode) {
      case "split":
        return {
          ...(splitSource === "existing" ? { networkId: Number(splitNet) } : { cidr: splitCidr }),
          newPrefix: numOrUndef(splitPrefix),
        };
      case "merge":
        return {
          networkIds: mergeIds.map(Number),
          cidrs: mergeText.split(/[\s,;]+/).filter(Boolean),
        };
      case "free":
        return { parent: freeParent, vrfId: numOrUndef(freeVrf) ?? null, prefix: numOrUndef(freePrefix) };
      case "fit":
        return { cidr: fitCidr, vrfId: numOrUndef(fitVrf) ?? null };
    }
  };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "merge" && mergeIds.length === 0 && mergeText.trim() === "") {
      setError(s.merge.pickSomething);
      setResult(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/simulator/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
      if (!res.ok || data.result === undefined) throw new Error(data.error ?? s.failed);
      setResult({ mode, data: data.result });
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : s.failed);
    } finally {
      setBusy(false);
    }
  };

  const vrfSelect = (value: string, onChange: (v: string) => void, id: string) => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="input">
      <option value="">{s.globalVrf}</option>
      {vrfs.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  );

  const label = "mb-1 block text-xs font-medium text-fg2";
  const hint = "mt-1 text-[11px] text-muted";

  return (
    <div className="space-y-6">
      <nav aria-label={s.tabsLabel} role="tablist" className="flex flex-wrap items-center gap-2">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={m === mode}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={
              m === mode
                ? "rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg2 hover:bg-panel2"
            }
          >
            {s.tabs[m]}
          </button>
        ))}
      </nav>

      <p className="text-sm text-muted">{s.descriptions[mode]}</p>

      <form onSubmit={run} className="card space-y-4 p-5" aria-label={s.tabs[mode]}>
        {mode === "split" && (
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className={label} htmlFor="sim-split-source">{s.split.source}</label>
              <select id="sim-split-source" value={splitSource} onChange={(e) => setSplitSource(e.target.value as "existing" | "typed")} className="input">
                <option value="existing" disabled={networks.length === 0}>{s.split.existing}</option>
                <option value="typed">{s.split.typed}</option>
              </select>
            </div>
            <div>
              {splitSource === "existing" ? (
                <>
                  <label className={label} htmlFor="sim-split-net">{s.network}</label>
                  <select id="sim-split-net" value={splitNet} onChange={(e) => setSplitNet(e.target.value)} className="input">
                    {networks.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.cidr} — {n.name}
                        {n.vrfName ? ` (${n.vrfName})` : ""}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label className={label} htmlFor="sim-split-cidr">{s.cidr}</label>
                  <input id="sim-split-cidr" className="input font-mono" value={splitCidr} onChange={(e) => setSplitCidr(e.target.value)} placeholder="10.0.0.0/22" />
                </>
              )}
            </div>
            <div>
              <label className={label} htmlFor="sim-split-prefix">{s.split.newPrefix}</label>
              <input id="sim-split-prefix" className="input" inputMode="numeric" value={splitPrefix} onChange={(e) => setSplitPrefix(e.target.value)} placeholder="26" />
              <p className={hint}>{s.split.newPrefixHint}</p>
            </div>
          </div>
        )}

        {mode === "merge" && (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={label} htmlFor="sim-merge-nets">{s.merge.networks}</label>
              <select
                id="sim-merge-nets"
                multiple
                size={Math.min(8, Math.max(3, networks.length))}
                value={mergeIds}
                onChange={(e) => {
                  const picked: string[] = [];
                  const opts = e.target.options;
                  for (let i = 0; i < opts.length; i++) if (opts[i].selected) picked.push(opts[i].value);
                  setMergeIds(picked);
                }}
                className="input h-auto py-1"
              >
                {networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.cidr} — {n.name}
                  </option>
                ))}
              </select>
              <p className={hint}>{s.merge.networksHint}</p>
            </div>
            <div>
              <label className={label} htmlFor="sim-merge-text">{s.merge.extra}</label>
              <textarea id="sim-merge-text" rows={5} className="input h-auto py-2 font-mono" value={mergeText} onChange={(e) => setMergeText(e.target.value)} placeholder={s.merge.extraPlaceholder} />
              <p className={hint}>{s.merge.extraHint}</p>
            </div>
          </div>
        )}

        {mode === "free" && (
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className={label} htmlFor="sim-free-parent">{s.free.parent}</label>
              <input id="sim-free-parent" className="input font-mono" value={freeParent} onChange={(e) => setFreeParent(e.target.value)} placeholder="10.0.0.0/16" />
            </div>
            <div>
              <label className={label} htmlFor="sim-free-vrf">{s.vrf}</label>
              {vrfSelect(freeVrf, setFreeVrf, "sim-free-vrf")}
            </div>
            <div>
              <label className={label} htmlFor="sim-free-prefix">{s.free.prefix}</label>
              <input id="sim-free-prefix" className="input" inputMode="numeric" value={freePrefix} onChange={(e) => setFreePrefix(e.target.value)} placeholder="24" />
              <p className={hint}>{s.free.prefixHint}</p>
            </div>
          </div>
        )}

        {mode === "fit" && (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={label} htmlFor="sim-fit-cidr">{s.cidr}</label>
              <input id="sim-fit-cidr" className="input font-mono" value={fitCidr} onChange={(e) => setFitCidr(e.target.value)} placeholder="10.1.10.0/24" />
            </div>
            <div>
              <label className={label} htmlFor="sim-fit-vrf">{s.vrf}</label>
              {vrfSelect(fitVrf, setFitVrf, "sim-fit-vrf")}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy}>
            <FlaskConical className="h-4 w-4" />
            {busy ? s.running : s.run}
          </button>
          <span className="text-xs text-muted">{s.readOnly}</span>
        </div>
      </form>

      {error && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      {result && result.mode === mode && (
        <section className="card p-5" aria-live="polite" aria-label={s.tabs[mode]}>
          {result.mode === "split" && <SplitOut r={result.data as SplitResult} />}
          {result.mode === "merge" && <MergeOut r={result.data as MergeResult} />}
          {result.mode === "free" && <FreeOut r={result.data as FreeResult} />}
          {result.mode === "fit" && <FitOut r={result.data as FitResult} />}
        </section>
      )}
    </div>
  );

  /* ------------------------------ résultats ------------------------------ */

  function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              {head.map((h) => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className="px-3 py-2 text-fg2">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function SplitOut({ r }: { r: SplitResult }) {
    const x = s.split;
    return (
      <div className="space-y-4">
        <p className="text-sm font-semibold text-fg">
          {format(x.summary, { count: big(r.count, locale), prefix: r.newPrefix, usable: big(r.usablePerChild, locale) })}
        </p>
        <p className="text-xs text-muted">{r.existing ? format(x.existingNote, { name: r.existing.name }) : x.typedNote}</p>
        <Table
          head={[x.columns.subnet, x.columns.inventoried, x.columns.conflicts]}
          rows={r.children.map((c) => [
            <span key="c" className="font-mono">{c.cidr}</span>,
            c.inventoried,
            c.conflicts.length ? <span key="x" className="font-mono text-bad">{c.conflicts.join(", ")}</span> : x.noConflict,
          ])}
        />
        {r.truncated && <p className="text-xs text-muted">{format(x.truncated, { n: r.children.length })}</p>}
        {r.existing && (
          <div>
            <h3 className="card-title mb-1">{x.spanningTitle}</h3>
            {r.spanningScopes.length === 0 ? (
              <p className="text-sm text-muted">{x.spanningNone}</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-muted">{x.spanningHint}</p>
                <ul className="space-y-1 text-sm text-warn">
                  {r.spanningScopes.map((sc) => (
                    <li key={sc.id}>
                      {sc.name} <span className="font-mono">({sc.rangeStart} – {sc.rangeEnd})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  function MergeOut({ r }: { r: MergeResult }) {
    const x = s.merge;
    return (
      <div className="space-y-4">
        <div>
          <h3 className="card-title mb-1">{x.summaryTitle}</h3>
          <p className="mb-2 text-xs text-muted">{x.summaryHint}</p>
          <p className="font-mono text-sm text-fg">{r.summary.join("  ·  ")}</p>
        </div>
        <div>
          <h3 className="card-title mb-1">{x.supernetTitle}</h3>
          {r.supernet ? (
            <>
              <p className="font-mono text-sm text-fg">{r.supernet}</p>
              <p className={`mt-1 text-sm ${r.exact ? "text-ok" : "text-warn"}`}>
                {r.exact ? x.exactYes : format(x.exactNo, { n: big(r.extraAddresses ?? "0", locale) })}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">{x.noSupernet}</p>
          )}
        </div>
        {r.supernet && (
          <div>
            <h3 className="card-title mb-1">{x.intrudersTitle}</h3>
            {r.intruders.length === 0 ? (
              <p className="text-sm text-muted">{x.intrudersNone}</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-muted">{x.intrudersHint}</p>
                <ul className="space-y-1 text-sm text-bad">
                  {r.intruders.map((n) => (
                    <li key={n.id}>
                      <span className="font-mono">{n.cidr}</span> — {n.name}
                      {n.vrfName ? ` (${n.vrfName})` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  function FreeOut({ r }: { r: FreeResult }) {
    const x = s.free;
    return (
      <div className="space-y-4">
        <p className="text-sm font-semibold text-fg">
          {format(x.summary, { free: big(r.freeAddresses, locale), total: big(r.totalAddresses, locale) })}
        </p>
        {r.prefix !== null && (
          <p className={`text-sm ${r.firstFit ? "text-ok" : "text-bad"}`}>
            {r.firstFit ? format(x.firstFit, { prefix: r.prefix, cidr: r.firstFit }) : format(x.noFit, { prefix: r.prefix })}
          </p>
        )}
        <div>
          <h3 className="card-title mb-2">{x.blocksTitle}</h3>
          {r.blocks.length === 0 ? (
            <p className="text-sm text-muted">{x.noBlocks}</p>
          ) : (
            <Table head={[x.columns.block, x.columns.addresses]} rows={r.blocks.map((b) => [<span key="b" className="font-mono">{b.cidr}</span>, big(b.addresses, locale)])} />
          )}
        </div>
        <div>
          <h3 className="card-title mb-1">{x.takenTitle}</h3>
          {r.taken.length === 0 ? <p className="text-sm text-muted">{x.takenNone}</p> : <p className="font-mono text-sm text-fg2">{r.taken.join("  ·  ")}</p>}
        </div>
      </div>
    );
  }

  function FitOut({ r }: { r: FitResult }) {
    const x = s.fit;
    return (
      <div className="space-y-4">
        <p className={`text-sm font-semibold ${r.canCreate ? "text-ok" : "text-bad"}`}>
          {r.canCreate ? x.canCreate : format(x.cannotCreate, { n: r.conflicts.length })}
        </p>
        {r.conflicts.length > 0 && (
          <div>
            <h3 className="card-title mb-2">{x.conflictsTitle}</h3>
            <Table
              head={[x.columns.network, x.columns.name, x.columns.relation]}
              rows={r.conflicts.map((c) => [<span key="c" className="font-mono">{c.cidr}</span>, c.name, x.relations[c.relation]])}
            />
            <p className="mt-3 text-sm text-fg2">{r.suggestion ? format(x.suggestion, { cidr: r.suggestion }) : x.noSuggestion}</p>
          </div>
        )}
        {r.otherVrf.length > 0 && (
          <div>
            <h3 className="card-title mb-1">{x.otherVrfTitle}</h3>
            <p className="mb-2 text-xs text-muted">{x.otherVrfHint}</p>
            <ul className="space-y-1 text-sm text-fg2">
              {r.otherVrf.map((n) => (
                <li key={n.id}>
                  <span className="font-mono">{n.cidr}</span> — {n.name} ({n.vrfName ?? s.globalVrf})
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
}
