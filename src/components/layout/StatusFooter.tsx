"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

interface Health {
  api: boolean;
  database: boolean;
  responseMs: number;
}

function Dot({ ok }: { ok: boolean | null }) {
  const color = ok === null ? "bg-muted" : ok ? "bg-ok" : "bg-bad";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export function StatusFooter() {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const t0 = performance.now();
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as Health;
        if (!alive) return;
        setHealth({ ...data, responseMs: Math.round(performance.now() - t0) });
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const apiOk = failed ? false : health ? health.api : null;
  const dbOk = failed ? false : health ? health.database : null;
  const operational = apiOk === true && dbOk === true;

  return (
    <footer className="flex h-11 shrink-0 items-center gap-4 border-t border-line bg-bg px-4 text-xs text-muted sm:px-6">
      <span className="hidden sm:inline">{t.footer.version}</span>
      <span
        className={`flex items-center gap-1.5 rounded border px-2 py-0.5 ${
          operational ? "border-ok/30 bg-ok/10 text-ok" : "border-bad/30 bg-bad/10 text-bad"
        }`}
      >
        <Sparkles className="h-3 w-3" />
        {health === null && !failed ? t.footer.checking : operational ? t.footer.operational : t.footer.degraded}
      </span>

      <div className="ml-auto flex items-center gap-5">
        <span className="flex items-center gap-2">
          {t.footer.api} <Dot ok={apiOk} />
        </span>
        <span className="flex items-center gap-2">
          {t.footer.database} <Dot ok={dbOk} />
        </span>
        <span className="hidden md:inline">
          {t.footer.responseTime}: {health ? `${health.responseMs}ms` : "—"}
        </span>
      </div>
    </footer>
  );
}
