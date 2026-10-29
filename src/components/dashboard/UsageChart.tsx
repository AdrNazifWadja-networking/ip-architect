"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown } from "lucide-react";
import { CHART_PALETTE, useTheme } from "@/components/ThemeProvider";
import { useI18n } from "@/lib/i18n/client";
import { fmtPct, shortDay } from "@/lib/format";

interface Point {
  day: string;
  ipv4: number;
  ipv6: number;
  active: number;
}

export function UsageChart({ data }: { data: Point[] }) {
  const { t, locale } = useI18n();
  const { theme } = useTheme();
  const palette = CHART_PALETTE[theme];
  const [range, setRange] = useState(30);

  const series = [
    { key: "ipv4", label: t.dashboard.evolution.ipv4, color: palette.tones.ipv4 },
    { key: "ipv6", label: t.dashboard.evolution.ipv6, color: palette.tones.ipv6 },
    { key: "active", label: t.dashboard.evolution.activeNetworks, color: palette.tones.ok },
  ] as const;

  const ranges = [
    { value: 7, label: t.dashboard.evolution.last7 },
    { value: 14, label: t.dashboard.evolution.last14 },
    { value: 30, label: t.dashboard.evolution.last30 },
  ];

  const shown = useMemo(
    () => data.slice(-(range + 1)).map((p) => ({ ...p, label: shortDay(p.day, locale) })),
    [data, range, locale],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-fg2">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <div className="relative">
          <select
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
            aria-label={t.dashboard.evolution.range}
            className="h-8 appearance-none rounded-md border border-line bg-panel2 pl-3 pr-8 text-xs text-fg2 focus:border-brand focus:outline-none"
          >
            {ranges.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        </div>
      </div>

      <div className="h-[230px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={shown} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke={palette.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: palette.tick, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={{ fill: palette.tick, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: palette.tooltipBg,
                border: `1px solid ${palette.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: palette.tooltipText, fontWeight: 600 }}
              itemStyle={{ color: palette.tooltipText }}
              formatter={(value, name) => [fmtPct(Number(value), locale), String(name)]}
            />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#grad-${s.key})`}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
