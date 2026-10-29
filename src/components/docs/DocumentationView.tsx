"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Info, Printer, Search, Sparkles, X } from "lucide-react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { DOC_GROUPS, searchTerms, sectionText, type ApiDoc, type DocBlock, type DocSection, type NoteKind } from "@/lib/docs/types";

interface Props {
  sections: DocSection[];
  api: ApiDoc[];
}

const NOTE_STYLE: Record<NoteKind, string> = {
  tip: "border-brand/40 bg-brand/10",
  warning: "border-warn/40 bg-warn/10",
  info: "border-line bg-panel2",
};

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-ok/15 text-ok",
  POST: "bg-brand/15 text-brand-soft",
  PATCH: "bg-warn/15 text-warn",
  DELETE: "bg-bad/15 text-bad",
};

export function DocumentationView({ sections, api }: Props) {
  const { t } = useI18n();
  const d = t.docs;
  const [query, setQuery] = useState("");

  // texte de recherche calculé une fois par section (la documentation ne change pas pendant la visite)
  const indexed = useMemo(() => sections.map((s) => ({ s, text: sectionText(s, api) })), [sections, api]);
  const terms = searchTerms(query);
  const visible = terms.length === 0 ? sections : indexed.filter((x) => terms.every((w) => x.text.includes(w))).map((x) => x.s);

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="no-print lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
        <div className="card p-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={d.searchLabel}
              placeholder={d.searchPlaceholder}
              maxLength={80}
              className="input pl-9 pr-8"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label={d.clear} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {terms.length > 0 && (
            <p className="mt-2 text-xs text-muted" role="status">
              {format(d.results, { n: visible.length })}
            </p>
          )}
          <nav aria-label={d.contents} className="mt-3 space-y-3">
            {DOC_GROUPS.map((g) => {
              const items = visible.filter((s) => s.group === g);
              if (items.length === 0) return null;
              return (
                <div key={g}>
                  <div className="label-caps mb-1">{d.groups[g]}</div>
                  <ul className="space-y-0.5">
                    {items.map((s) => (
                      <li key={s.id}>
                        <a href={`#${s.id}`} className="block rounded px-2 py-1 text-sm text-fg2 hover:bg-panel2 hover:text-fg">
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
          <button type="button" onClick={() => window.print()} className="btn-ghost mt-3 w-full">
            <Printer className="h-4 w-4" />
            {d.print}
          </button>
        </div>
      </aside>

      <div className="min-w-0 space-y-6">
        {visible.length === 0 && (
          <div className="card px-6 py-12 text-center text-sm text-muted" role="status">
            {format(d.noResults, { q: query.trim() })}
          </div>
        )}
        {DOC_GROUPS.map((g) => {
          const items = visible.filter((s) => s.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g} className="space-y-6">
              <h2 className="label-caps border-b border-line pb-1">{d.groups[g]}</h2>
              {items.map((s) => (
                <Section key={s.id} section={s} api={api} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ section, api }: { section: DocSection; api: ApiDoc[] }) {
  const { t } = useI18n();
  return (
    <section id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-4 rounded-lg border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`${section.id}-title`} className="text-lg font-semibold text-fg">
            {section.title}
          </h3>
          <p className="mt-0.5 text-sm text-muted">{section.summary}</p>
        </div>
        {section.open && (
          <Link href={section.open.href} className="btn-ghost no-print h-8 px-3 text-xs">
            {section.open.label}
          </Link>
        )}
      </div>
      <div className="mt-4 space-y-3 text-sm leading-relaxed text-fg2">
        {section.blocks.map((b, i) => (
          <Block key={i} block={b} api={api} noteLabels={t.docs.notes} />
        ))}
      </div>
    </section>
  );
}

function Block({ block, api, noteLabels }: { block: DocBlock; api: ApiDoc[]; noteLabels: Record<NoteKind, string> }) {
  const { t } = useI18n();
  switch (block.t) {
    case "p":
      return <p>{block.text}</p>;
    case "h3":
      return <h4 className="pt-1 text-sm font-semibold text-fg">{block.text}</h4>;
    case "ul":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-line bg-panel2 p-3 font-mono text-[12.5px] text-fg">
          <code>{block.text}</code>
        </pre>
      );
    case "note": {
      const Icon = block.kind === "warning" ? AlertTriangle : block.kind === "tip" ? Sparkles : Info;
      return (
        <div role="note" className={`flex gap-3 rounded-md border p-3 ${NOTE_STYLE[block.kind]}`}>
          <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg" />
          <p>
            <strong className="font-semibold text-fg">{noteLabels[block.kind]}</strong>{" "}
            {block.text}
          </p>
        </div>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-panel2 text-fg">
              <tr>
                {block.head.map((h) => (
                  <th key={h} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-line align-top">
                  {row.map((c, j) => (
                    <td key={j} className={j === 0 ? "px-3 py-2 font-medium text-fg" : "px-3 py-2"}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "api": {
      const a = t.docs.api;
      return (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-panel2 text-fg">
              <tr>
                <th className="px-3 py-2 font-semibold">{a.method}</th>
                <th className="px-3 py-2 font-semibold">{a.route}</th>
                <th className="px-3 py-2 font-semibold">{a.access}</th>
                <th className="px-3 py-2 font-semibold">{a.description}</th>
              </tr>
            </thead>
            <tbody>
              {api.map((r) => (
                <tr key={`${r.method} ${r.path}`} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${METHOD_STYLE[r.method] ?? ""}`}>{r.method}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-fg">{r.path}</td>
                  <td className="whitespace-nowrap px-3 py-2">{a[`access_${r.access}` as const]}</td>
                  <td className="px-3 py-2">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}
