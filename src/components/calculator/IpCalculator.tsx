"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { bitsOf, calcSubnet, ipInCidr, parseIp, parseIPv4, splitCidr, type SubnetInfo } from "@/lib/ip/cidr";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { formatCount } from "@/lib/format";

/** 255.255.255.0 -> 11111111.11111111.11111111.00000000 */
function binaryMask(mask: string): string | null {
  const v = parseIPv4(mask);
  if (v === null) return null;
  return v
    .toString(2)
    .padStart(32, "0")
    .match(/.{8}/g)!
    .join(".");
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={format(t.calculator.copy, { text })}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* presse-papiers indisponible : on ignore */
        }
      }}
      className="rounded p-1 text-muted hover:bg-panel2 hover:text-fg"
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function ResultRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-right">
        <span className={`truncate text-[13px] font-medium text-fg ${mono ? "font-mono" : ""}`}>{value}</span>
        <CopyButton text={value} />
      </dd>
    </div>
  );
}

export function IpCalculator() {
  const { t, locale } = useI18n();
  const c = t.calculator;

  const [input, setInput] = useState("192.168.1.0/24");
  const [newPrefix, setNewPrefix] = useState<number | "">("");
  const [probe, setProbe] = useState("");

  const info: SubnetInfo | null = useMemo(() => calcSubnet(input.trim()), [input]);
  const invalid = input.trim() !== "" && !info;

  // Préfixes proposés pour le découpage : jusqu'à 16 niveaux plus fins
  const prefixOptions = useMemo(() => {
    if (!info) return [];
    const max = Math.min(bitsOf(info.version), info.prefix + 16);
    const list: number[] = [];
    for (let p = info.prefix + 1; p <= max; p++) list.push(p);
    return list;
  }, [info]);

  const effectivePrefix = typeof newPrefix === "number" && prefixOptions.includes(newPrefix) ? newPrefix : prefixOptions[0];

  const subnets = useMemo(
    () => (info && effectivePrefix ? splitCidr(info.cidr, effectivePrefix, 256) : null),
    [info, effectivePrefix],
  );
  const subnetCount = info && effectivePrefix ? 1n << BigInt(effectivePrefix - info.prefix) : 0n;

  const probeParsed = probe.trim() ? parseIp(probe.trim()) : null;
  const probeResult = info && probeParsed ? ipInCidr(probe.trim(), info.cidr) : null;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.2fr]">
      {/* Saisie + résultats */}
      <div className="card p-5">
        <h2 className="card-title">{c.analysis.title}</h2>
        <label htmlFor="calc-cidr" className="label-caps mb-1.5 mt-4 block">
          {c.analysis.addressPrefix}
        </label>
        <input
          id="calc-cidr"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={c.analysis.placeholder}
          spellCheck={false}
          className={`input font-mono ${invalid ? "border-bad focus:border-bad focus:ring-bad" : ""}`}
        />
        {invalid && <p className="mt-1.5 text-xs text-bad">{c.analysis.invalid}</p>}

        {info && (
          <dl className="mt-4 divide-y divide-line">
            <ResultRow label={c.rows.version} value={`IPv${info.version}`} mono={false} />
            <ResultRow label={c.rows.network} value={info.network} />
            {info.broadcast && <ResultRow label={c.rows.broadcast} value={info.broadcast} />}
            <ResultRow label={c.rows.mask} value={info.netmask} />
            {info.wildcard && <ResultRow label={c.rows.wildcard} value={info.wildcard} />}
            <ResultRow label={c.rows.firstHost} value={info.firstHost} />
            <ResultRow label={c.rows.lastHost} value={info.lastHost} />
            <ResultRow label={c.rows.total} value={formatCount(info.total, locale)} mono={false} />
            <ResultRow label={c.rows.usable} value={formatCount(info.usable, locale)} mono={false} />
          </dl>
        )}

        {info && info.version === 4 && (
          <div className="mt-4 rounded-md border border-line bg-panel2 p-3">
            <div className="label-caps mb-1">{c.binaryMask}</div>
            <code className="break-all font-mono text-xs text-brand-soft">{binaryMask(info.netmask)}</code>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {/* Test d'appartenance */}
        <div className="card p-5">
          <h2 className="card-title">{c.probe.title}</h2>
          <input
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            placeholder="192.168.1.77"
            aria-label={c.probe.ariaLabel}
            spellCheck={false}
            disabled={!info}
            className="input mt-4 font-mono"
          />
          {probe.trim() !== "" && !probeParsed && <p className="mt-2 text-xs text-bad">{c.probe.invalidIp}</p>}
          {probeParsed && info && probeResult !== null && (
            <p className={`mt-2 text-sm font-medium ${probeResult ? "text-ok" : "text-bad"}`}>
              {probeResult
                ? format(c.probe.yes, { ip: probe.trim(), cidr: info.cidr })
                : probeParsed.version !== info.version
                  ? c.probe.noVersion
                  : format(c.probe.noOutside, { ip: probe.trim(), cidr: info.cidr })}
            </p>
          )}
        </div>

        {/* Découpage */}
        <div className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="card-title">{c.split.title}</h2>
            {info && prefixOptions.length > 0 && (
              <select
                value={effectivePrefix}
                onChange={(e) => setNewPrefix(Number(e.target.value))}
                aria-label={c.split.newPrefix}
                className="input w-auto"
              >
                {prefixOptions.map((p) => (
                  <option key={p} value={p}>
                    /{p}
                  </option>
                ))}
              </select>
            )}
          </div>

          {!info && <p className="mt-4 text-sm text-muted">{c.split.enterValid}</p>}
          {info && prefixOptions.length === 0 && <p className="mt-4 text-sm text-muted">{c.split.cannotSplit}</p>}

          {info && subnets && (
            <>
              <p className="mt-3 text-xs text-muted">
                {format(c.split.count, { n: formatCount(subnetCount, locale), prefix: effectivePrefix })}
                {subnetCount > 256n && ` — ${c.split.limited}`}
              </p>
              <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
                {subnets.map((s) => (
                  <li key={s} className="flex items-center justify-between px-3 py-1.5">
                    <span className="font-mono text-[13px] text-fg2">{s}</span>
                    <CopyButton text={s} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
