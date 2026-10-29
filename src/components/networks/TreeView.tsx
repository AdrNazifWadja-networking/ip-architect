"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TreeNode } from "@/lib/ip/tree";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { fmtInt } from "@/lib/format";
import { TagChip } from "@/components/meta/MetaInputs";

interface Group {
  key: string;
  title: string;
  roots: TreeNode[];
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line" aria-hidden>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function Node({ node, depth, open }: { node: TreeNode; depth: number; open: boolean }) {
  const { t, locale } = useI18n();
  const pad = { paddingLeft: `${depth * 20}px` };

  if (node.kind === "network") {
    const tone = node.usagePct >= 85 ? "bg-bad" : node.usagePct >= 65 ? "bg-warn" : "bg-ok";
    return (
      <li className="flex flex-wrap items-center gap-3 border-b border-line py-2 pr-3 text-sm" style={pad}>
        <span className="inline-block w-4" />
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${node.version === 4 ? "bg-ipv4/20 text-ipv4" : "bg-ipv6/20 text-ipv6"}`}>v{node.version}</span>
        <Link href={`/ipam/${node.networkId}`} title={t.tree.openIpam} className="font-mono text-[13px] text-fg hover:text-brand-soft hover:underline">
          {node.cidr}
        </Link>
        <span className="text-fg2">{node.name}</span>
        {node.tags.map((tag) => (
          <TagChip key={tag.id} tag={tag} />
        ))}
        {node.version === 4 && (
          <span className="ml-auto flex items-center gap-2 text-xs text-muted">
            {format(t.tree.usage, { used: fmtInt(node.used, locale), capacity: fmtInt(node.capacity, locale) })}
            <Bar pct={node.usagePct} tone={tone} />
          </span>
        )}
      </li>
    );
  }

  return (
    <li>
      <details open={open || depth === 0} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 border-b border-line bg-panel2/40 py-2 pr-3 text-sm hover:bg-panel2" style={pad}>
          <ChevronRight className="h-4 w-4 text-muted group-open:hidden" />
          <ChevronDown className="hidden h-4 w-4 text-muted group-open:block" />
          <span className="font-mono text-[13px] font-semibold text-fg">{node.cidr}</span>
          <span className="text-xs text-muted">{t.tree.block}</span>
          <span className="text-xs text-fg2">{format(t.tree.networks, { n: node.networkCount })}</span>
          <span className="ml-auto flex items-center gap-3 text-xs text-muted">
            {format(t.tree.allocated, { pct: node.allocatedPct.toLocaleString(locale, { maximumFractionDigits: 2 }) })}
            <Bar pct={node.allocatedPct} tone="bg-brand" />
            {node.version === 4 && node.capacity > 0 && format(t.tree.usage, { used: fmtInt(node.used, locale), capacity: fmtInt(node.capacity, locale) })}
          </span>
        </summary>
        <ul>
          {node.children.map((c) => (
            <Node key={c.key} node={c} depth={depth + 1} open={open} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function TreeView({ groups, vrfs, selected }: { groups: Group[]; vrfs: { id: number; name: string }[]; selected: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [gen, setGen] = useState(0); // change la clé : les <details> repartent de l'état demandé

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(e) => router.replace(e.target.value ? `/arborescence?vrf=${e.target.value}` : "/arborescence")}
          aria-label={t.tree.vrfFilter}
          className="input w-auto"
        >
          <option value="">{t.tree.allVrfs}</option>
          <option value="none">{t.tree.global}</option>
          {vrfs.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => { setOpen(true); setGen(gen + 1); }}>
          {t.tree.expandAll}
        </button>
        <button className="btn-ghost" onClick={() => { setOpen(false); setGen(gen + 1); }}>
          {t.tree.collapseAll}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="card px-4 py-12 text-center text-muted">{t.tree.empty}</div>
      ) : (
        groups.map((g) => (
          <section key={`${g.key}-${gen}`} className="card mb-4 overflow-hidden">
            <h2 className="card-title px-4 pb-2 pt-4">{g.title}</h2>
            <ul>
              {g.roots.map((n) => (
                <Node key={n.key} node={n} depth={0} open={open} />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
