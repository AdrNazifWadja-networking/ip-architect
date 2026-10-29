"use client";

import { Cell, Pie, PieChart } from "recharts";
import { CHART_PALETTE, useTheme, type Tone } from "@/components/ThemeProvider";

export interface DonutSegment {
  name: string;
  value: number;
  /** couleur sémantique : résolue selon le thème clair/sombre */
  tone: Tone;
}

interface Props {
  segments: DonutSegment[];
  centerTop: string;
  centerBottom?: string;
  size?: number;
  thickness?: number;
}

/** Anneau avec texte central. Si toutes les valeurs sont nulles, affiche un anneau vide. */
export function Donut({ segments, centerTop, centerBottom, size = 170, thickness = 18 }: Props) {
  const { theme } = useTheme();
  const palette = CHART_PALETTE[theme];

  const total = segments.reduce((a, s) => a + s.value, 0);
  const data =
    total > 0
      ? segments.map((s) => ({ name: s.name, value: s.value, color: palette.tones[s.tone] }))
      : [{ name: "empty", value: 1, color: palette.track }];

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <PieChart width={size} height={size}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={size / 2 - thickness}
          outerRadius={size / 2 - 2}
          startAngle={90}
          endAngle={-270}
          stroke="none"
          paddingAngle={data.length > 1 ? 1 : 0}
          isAnimationActive={false}
        >
          {data.map((s) => (
            <Cell key={s.name} fill={s.color} />
          ))}
        </Pie>
      </PieChart>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[22px] font-bold leading-tight text-fg">{centerTop}</span>
        {centerBottom && <span className="text-xs text-muted">{centerBottom}</span>}
      </div>
    </div>
  );
}
