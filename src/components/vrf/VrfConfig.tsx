"use client";

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

interface Props {
  vrfName: string;
  config: string;
}

export function VrfConfig({ vrfName, config }: Props) {
  const { t } = useI18n();
  const c = t.vrf.detail.config;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(c.copyFailed);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([config], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vrf-${vrfName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">{c.title}</h2>
        <div className="flex items-center gap-2">
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
        {config}
      </pre>
    </section>
  );
}
