"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

/**
 * Script exécuté AVANT le premier rendu (voir layout.tsx) pour éviter le flash de mauvais thème.
 * Priorité : choix enregistré > préférence système.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.classList.toggle("dark",t==="dark")}catch(e){}})();`;

interface ThemeValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // "dark" au premier rendu (identique serveur/client) ; la vraie valeur est lue juste après le montage.
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    setThemeState(document.documentElement.classList.contains("dark") ? "dark" : "light");

    // Sans choix explicite, on suit les changements de thème du système.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem(THEME_STORAGE_KEY)) return;
      } catch {
        /* stockage indisponible : on suit le système */
      }
      const next: Theme = e.matches ? "dark" : "light";
      apply(next);
      setThemeState(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    apply(next);
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* navigation privée : le choix vaut pour cette session seulement */
    }
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme doit être utilisé à l'intérieur de <ThemeProvider>");
  return ctx;
}

/** Couleurs sémantiques utilisables dans les graphiques (clé = ton demandé par les composants). */
export type Tone = "ok" | "warn" | "bad" | "neutral" | "ipv4" | "ipv6";

export interface ChartPalette {
  grid: string;
  tick: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  track: string;
  tones: Record<Tone, string>;
}

/** Couleurs des graphiques SVG (Recharts n'accepte pas les variables CSS partout, on lui passe des valeurs).
 *  Les teintes reprennent celles de globals.css (--ok, --warn, --bad, --neutral, --ipv4, --ipv6). */
export const CHART_PALETTE: Record<Theme, ChartPalette> = {
  dark: {
    grid: "#1b2440",
    tick: "#8a94b0",
    tooltipBg: "#0c1224",
    tooltipBorder: "#1b2440",
    tooltipText: "#e2e8f0",
    track: "#1b2440",
    tones: { ok: "#22c55e", warn: "#f59e0b", bad: "#ef4444", neutral: "#475569", ipv4: "#8b5cf6", ipv6: "#3b82f6" },
  },
  light: {
    grid: "#e2e7f2",
    tick: "#64748b",
    tooltipBg: "#ffffff",
    tooltipBorder: "#e2e7f2",
    tooltipText: "#0f172a",
    track: "#e2e7f2",
    tones: { ok: "#16a34a", warn: "#d97706", bad: "#dc2626", neutral: "#94a3b8", ipv4: "#7c3aed", ipv6: "#2563eb" },
  },
};
