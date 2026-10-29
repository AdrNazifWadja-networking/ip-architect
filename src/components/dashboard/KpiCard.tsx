interface Props {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  /** classes Tailwind du médaillon d'icône (fond + couleur) */
  tint: string;
  delta?: { text: string; good: boolean } | null;
}

export function KpiCard({ label, value, sub, icon, tint, delta }: Props) {
  return (
    <div className="card flex items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="label-caps">{label}</div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="text-[26px] font-bold leading-none text-fg">{value}</span>
          {delta && (
            <span className={`text-[11px] font-semibold ${delta.good ? "text-ok" : "text-bad"}`}>{delta.text}</span>
          )}
        </div>
        <div className="mt-2 truncate text-[13px] text-muted">{sub}</div>
      </div>
      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${tint}`}>{icon}</div>
    </div>
  );
}
