import { Building2 } from "lucide-react";
import { fmtPct } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

interface Props {
  sites: { name: string; pct: number }[];
  locale: Locale;
  emptyText: string;
}

export function TopSites({ sites, locale, emptyText }: Props) {
  if (sites.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">{emptyText}</p>;
  }

  return (
    <ul className="space-y-4">
      {sites.map((s) => {
        const bar =
          s.pct >= 60 ? "bg-gradient-to-r from-violet-600 to-violet-400" : "bg-gradient-to-r from-blue-600 to-blue-400";
        return (
          <li key={s.name}>
            <div className="mb-1.5 flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 text-fg2">
                <Building2 className="h-3.5 w-3.5 text-muted" />
                {s.name}
              </span>
              <span className="font-semibold text-fg">{fmtPct(s.pct, locale)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, s.pct)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
