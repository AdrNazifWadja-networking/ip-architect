"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Gauge, LogOut, ScrollText, Settings, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { SessionUser } from "@/lib/types";
import { useI18n } from "@/lib/i18n/client";
import { useDismiss } from "./useDismiss";

/**
 * Menu de l'engrenage : compte, réglages de l'application et déconnexion (la déconnexion de l'en-tête est masquée sur petit
 * écran). Les entrées d'administration n'apparaissent que pour un administrateur (ou application ouverte) ; le serveur
 * vérifie de toute façon le rôle sur chaque page.
 */
export function SettingsMenu({ user, iconBtn, onSignOut }: { user: SessionUser | null; iconBtn: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const m = t.header.menu;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  const isAdmin = user === null || user.role === "admin"; // null = application ouverte : tout le monde administre
  const item = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg2 hover:bg-panel2";
  const ico = "h-4 w-4 text-muted";

  return (
    <div ref={ref} className="relative">
      <button type="button" className={iconBtn} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={t.header.settings} title={m.title}>
        <Settings className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div role="menu" aria-label={m.title} className="absolute right-0 top-full z-50 mt-1.5 w-[270px] overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-xl">
          {user && (
            <div className="border-b border-line px-3 py-2.5">
              <p className="text-sm font-medium text-fg">{user.displayName}</p>
              <p className="text-xs text-muted">
                {user.username} · {t.users.roles[user.role]}
              </p>
            </div>
          )}
          <Link role="menuitem" href="/utilisateurs" onClick={close} className={item}>
            <Users className={ico} /> {m.account}
          </Link>
          <Link role="menuitem" href="/supervision" onClick={close} className={item}>
            <Gauge className={ico} /> {m.monitoring}
          </Link>
          {isAdmin && (
            <>
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{m.admin}</p>
              <Link role="menuitem" href="/parametres" onClick={close} className={item}>
                <ShieldCheck className={ico} /> {m.appSettings}
              </Link>
              <Link role="menuitem" href="/audit-logs" onClick={close} className={item}>
                <ScrollText className={ico} /> {m.audit}
              </Link>
              <Link role="menuitem" href="/assistant-ia" onClick={close} className={item}>
                <Sparkles className={ico} /> {m.assistant}
              </Link>
            </>
          )}
          {user && (
            <button type="button" role="menuitem" onClick={onSignOut} className={`${item} border-t border-line`}>
              <LogOut className={ico} /> {t.auth.signOut}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
