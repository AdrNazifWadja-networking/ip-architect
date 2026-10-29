"use client";

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { DhcpConfigFormat } from "@/lib/dhcp/config";

interface Props {
  scopeName: string;
  configs: Record<DhcpConfigFormat, string>;
}

const FILE_EXT: Record<DhcpConfigFormat, string> = { isc: "conf", cisco: "txt" };

export function ConfigExport({ scopeName, configs }: Props) {
  const { t } = useI18n();
  const c = t.dhcp.detail.config;
  const [format, setFormat] = useState<DhcpConfigFormat>("isc");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const text = configs[format];

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(c.copyFailed);
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scopeName.replace(/[^A-Za-z0-9_-]+/g, "-") || "dhcp"}-${format}.${FILE_EXT[format]}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">{c.title}</h2>
        <div className="flex items-center gap-2">
          <div role="tablist" className="flex rounded-md border border-line p-0.5">
            {(["isc", "cisco"] as const).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={format === f}
                onClick={() => setFormat(f)}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  format === f ? "bg-brand text-white" : "text-muted hover:text-fg"
                }`}
              >
                {c[f]}
              </button>
            ))}
          </div>
          <button onClick={copy} className="btn-ghost h-8 px-3 text-xs">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? c.copied : c.copy}
          </button>
          <button onClick={download} className="btn-ghost h-8 px-3 text-xs">
            <Download className="h-3.5 w-3.5" />
            {c.download}
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-muted">{c.hint}</p>
      {error && <p className="mb-2 text-xs text-bad">{error}</p>}
      <pre className="max-h-[420px] overflow-auto rounded-md border border-line bg-panel2 p-4 font-mono text-[12.5px] leading-relaxed text-fg2">
        {text}
      </pre>
    </section>
  );
}
