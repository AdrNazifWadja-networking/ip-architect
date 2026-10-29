"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Languages } from "lucide-react";
import { LOCALES } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

/** Menu de choix de langue. Ajouter une langue dans `LOCALES` l'ajoute automatiquement ici. */
export function LanguageSwitcher() {
  const { locale, t, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fermeture au clic extérieur et avec Échap
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.header.language}
        title={t.header.language}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-md px-2 text-muted hover:bg-panel2 hover:text-fg"
      >
        <Languages className="h-[18px] w-[18px]" />
        <span className="text-xs font-semibold uppercase">{locale}</span>
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1.5 min-w-[150px] overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-xl">
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === locale}
              lang={code}
              onClick={() => {
                setOpen(false);
                if (code !== locale) setLocale(code);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg2 hover:bg-panel2"
            >
              <span className="w-6 text-xs font-semibold uppercase text-muted">{code}</span>
              <span className="flex-1">{t.language[code]}</span>
              {code === locale && <Check className="h-4 w-4 text-brand-soft" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
