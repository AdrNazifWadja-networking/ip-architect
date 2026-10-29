"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, Upload } from "lucide-react";
import { CSV_ENTITIES, type CsvEntity, type ImportResult } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

export interface EntityInfo {
  header: string[];
  required: string[];
}

interface Props {
  counts: Record<CsvEntity, number>;
  specs: Record<CsvEntity, EntityInfo>;
}

type Delim = "semicolon" | "comma" | "tab";
const SHOWN_ERRORS = 100;

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function ImportExportView({ counts, specs }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const ie = t.importExport;
  const fileInput = useRef<HTMLInputElement>(null);

  const [delimiter, setDelimiter] = useState<Delim>(locale === "fr" ? "semicolon" : "comma");
  const [entity, setEntity] = useState<CsvEntity>("sites");
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [onExisting, setOnExisting] = useState<"skip" | "error">("skip");
  const [busy, setBusy] = useState<"check" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = () => {
    setResult(null);
    setError(null);
  };

  const chooseFile = async (f: File | undefined) => {
    reset();
    if (!f) return;
    try {
      setFile({ name: f.name, size: f.size, text: await f.text() });
    } catch {
      setFile(null);
      setError(ie.import.readFailed);
    }
  };

  const send = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? "check" : "run");
    setError(null);
    try {
      const res = await fetch(`/api/import/${entity}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: file.text, dryRun, onExisting }),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: ImportResult; error?: string };
      if (!res.ok || !data.result) throw new Error(data.error ?? ie.import.failed);
      setResult(data.result);
      if (data.result.committed) router.refresh(); // met à jour les compteurs de lignes exportables
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : ie.import.failed);
    } finally {
      setBusy(null);
    }
  };

  const ready = result !== null && result.dryRun && result.errors.length === 0 && result.created > 0;
  const spec = specs[entity];
  const r = ie.import.result;

  return (
    <div className="space-y-6">
      {/* ------------------------------ Export ------------------------------ */}
      <section className="card" aria-labelledby="export-title">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="export-title" className="card-title">
              {ie.export.title}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">{ie.export.intro}</p>
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="delimiter">
              {ie.export.separator}
            </label>
            <select id="delimiter" value={delimiter} onChange={(e) => setDelimiter(e.target.value as Delim)} className="input w-auto min-w-[230px]">
              {(["semicolon", "comma", "tab"] as const).map((d) => (
                <option key={d} value={d}>
                  {ie.export.separators[d]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-5 py-3 font-medium">{ie.export.columnData}</th>
                <th className="px-5 py-3 font-medium">{ie.export.columnRows}</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {CSV_ENTITIES.map((e) => {
                const label = ie.entities[e].label;
                return (
                  <tr key={e} className="hover:bg-panel2/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 font-semibold text-fg">
                        <FileSpreadsheet className="h-4 w-4 text-muted" />
                        {label}
                      </div>
                      <div className="ml-6 text-xs text-muted">{ie.entities[e].description}</div>
                    </td>
                    <td className="px-5 py-3 text-fg2">{format(ie.export.rows, { n: counts[e] })}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/api/export/${e}?delimiter=${delimiter}&template=1`}
                          aria-label={format(ie.export.templateLabel, { name: label })}
                          className="btn-ghost h-8 px-3 text-xs"
                        >
                          {ie.export.template}
                        </a>
                        <a
                          href={`/api/export/${e}?delimiter=${delimiter}`}
                          aria-label={format(ie.export.downloadLabel, { name: label })}
                          className="btn-primary h-8 px-3 text-xs"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {ie.export.download}
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">{ie.export.addressesNote}</p>
      </section>

      {/* ------------------------------ Import ------------------------------ */}
      <section className="card" aria-labelledby="import-title">
        <div className="border-b border-line px-5 py-4">
          <h2 id="import-title" className="card-title">
            {ie.import.title}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">{ie.import.intro}</p>
        </div>

        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="import-entity">
              {ie.import.entity}
            </label>
            <select
              id="import-entity"
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value as CsvEntity);
                reset();
              }}
              className="input"
            >
              {CSV_ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {ie.entities[e].label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted">
              {format(ie.import.columns, { list: spec.header.join(", ") })} ({format(ie.import.required, { list: spec.required.join(", ") })})
            </p>
          </div>

          <div>
            <span className="label-caps mb-1.5 block">{ie.import.file}</span>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              aria-label={ie.import.file}
              onChange={(e) => void chooseFile(e.target.files?.[0])}
            />
            <button type="button" className="btn-ghost w-full justify-start" onClick={() => fileInput.current?.click()}>
              <FileUp className="h-4 w-4" />
              <span className="truncate">{file ? format(ie.import.fileInfo, { name: file.name, size: fileSize(file.size) }) : ie.import.chooseFile}</span>
            </button>
          </div>

          <fieldset className="md:col-span-2">
            <legend className="label-caps mb-1.5">{ie.import.onExisting}</legend>
            <div className="flex flex-col gap-1.5 text-sm text-fg2 sm:flex-row sm:gap-6">
              {(["skip", "error"] as const).map((v) => (
                <label key={v} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="on-existing"
                    value={v}
                    checked={onExisting === v}
                    onChange={() => {
                      setOnExisting(v);
                      reset();
                    }}
                  />
                  {ie.import[v]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">
          <button className="btn-ghost" disabled={!file || busy !== null} onClick={() => void send(true)}>
            {busy === "check" ? ie.import.checking : ie.import.check}
          </button>
          <button className="btn-primary" disabled={!ready || busy !== null} onClick={() => void send(false)}>
            <Upload className="h-4 w-4" />
            {busy === "run" ? ie.import.running : ie.import.run}
          </button>
          <p className="text-xs text-muted">{ie.import.order}</p>
        </div>

        {error && (
          <div role="alert" className="mx-5 mb-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        {result && (
          <div className="border-t border-line px-5 py-4" aria-live="polite">
            {result.errors.length === 0 ? (
              <div className="flex items-center gap-2 text-sm font-semibold text-ok">
                <CheckCircle2 className="h-4 w-4" />
                {result.committed ? r.committed : r.simulation}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm font-semibold text-bad">
                <AlertTriangle className="h-4 w-4" />
                {r.rolledBack}
              </div>
            )}
            <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg2">
              <li>{format(r.total, { n: result.total })}</li>
              <li>{format(result.committed ? r.createdDone : r.created, { n: result.created })}</li>
              {result.skipped > 0 && <li>{format(r.skipped, { n: result.skipped })}</li>}
              {result.errors.length > 0 && <li className="font-semibold text-bad">{format(r.errors, { n: result.errors.length })}</li>}
            </ul>
            {result.ignoredColumns.length > 0 && (
              <p className="mt-2 text-xs text-muted">{format(r.ignored, { list: result.ignoredColumns.join(", ") })}</p>
            )}
            {ready && <p className="mt-2 text-xs text-muted">{r.readyHint}</p>}

            {result.errors.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-md border border-line">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                      <th className="w-20 px-3 py-2 font-medium">{r.line}</th>
                      <th className="px-3 py-2 font-medium">{r.message}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {result.errors.slice(0, SHOWN_ERRORS).map((e, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 font-mono text-fg2">{e.line}</td>
                        <td className="px-3 py-2 text-fg">{e.message ?? e.code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.errors.length > SHOWN_ERRORS && (
                  <p className="border-t border-line px-3 py-2 text-xs text-muted">
                    {format(r.moreErrors, { n: result.errors.length - SHOWN_ERRORS })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
