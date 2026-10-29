import Link from "next/link";
import { AlertTriangle, XOctagon, type LucideIcon } from "lucide-react";
import type { DashboardData } from "@/lib/types";
import { format, type Dictionary } from "@/lib/i18n";

const SEVERITY_STYLE: Record<"critical" | "warning", { row: string; badge: string; dot: string; icon: LucideIcon }> = {
  critical: { row: "border-bad/25 bg-bad/[0.07]", badge: "bg-bad/20 text-bad", dot: "bg-bad", icon: XOctagon },
  warning: { row: "border-warn/25 bg-warn/[0.07]", badge: "bg-warn/20 text-warn", dot: "bg-warn", icon: AlertTriangle },
};

/** Composant serveur : les contrôles de supervision en cours (mêmes données que la cloche, la page Supervision et les alertes e-mail). */
export function RecentAlerts({ alerts, t }: { alerts: DashboardData["alerts"]; t: Dictionary }) {
  if (alerts.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">{t.monitoring.findings.none}</p>;
  }

  return (
    <ul className="space-y-2">
      {alerts.map((a, i) => {
        const st = SEVERITY_STYLE[a.severity];
        const Icon = st.icon;
        return (
          <li key={`${a.kind}-${i}`} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${st.row}`}>
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${st.badge}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="break-words text-[13px] font-medium text-fg">{format(t.monitoring.findings[a.kind], a.params)}</div>
            </div>
            <Link href={a.href} className="flex shrink-0 items-center gap-1.5 text-[11px] text-brand-soft hover:underline">
              {t.monitoring.findings.fix}
              <span className={`h-2 w-2 rounded-full ${st.dot}`} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
