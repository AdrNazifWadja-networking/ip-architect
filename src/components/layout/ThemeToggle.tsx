"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { useI18n } from "@/lib/i18n/client";

/** Bascule clair/sombre. L'icône affichée est celle du thème VERS lequel on bascule. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const { t } = useI18n();
  const label = theme === "dark" ? t.header.switchToLight : t.header.switchToDark;

  return (
    <button type="button" onClick={toggle} className={className} aria-label={label} title={label}>
      {theme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}
