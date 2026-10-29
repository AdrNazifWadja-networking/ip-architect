"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutPanelLeft, LogOut, Search } from "lucide-react";
import type { SessionUser } from "@/lib/types";
import { useI18n } from "@/lib/i18n/client";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationsMenu } from "./NotificationsMenu";
import { SettingsMenu } from "./SettingsMenu";

interface Props {
  alertCount: number;
  /** null = application ouverte (aucun compte créé) : on affiche l'invite à activer la connexion. */
  user: SessionUser | null;
  onToggleSidebar: () => void;
}

export function Header({ alertCount, user, onToggleSidebar }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  // Raccourci clavier ⌘K / Ctrl+K pour focus la recherche
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/reseaux?q=${encodeURIComponent(q)}` : "/reseaux");
    inputRef.current?.blur();
  };

  const signOut = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // rechargement complet : plus aucune donnée de la session en mémoire
      window.location.assign("/login");
    }
  };

  const iconBtn =
    "relative flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-panel2 hover:text-fg";

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-bg px-4 sm:px-6">
      <button
        onClick={onToggleSidebar}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-panel text-fg2 hover:bg-panel2 lg:hidden"
        aria-label={t.header.toggleMenu}
      >
        <LayoutPanelLeft className="h-4 w-4" />
      </button>

      <form onSubmit={submit} className="relative w-full max-w-[390px]" role="search">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.header.searchPlaceholder}
          aria-label={t.header.searchLabel}
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-14 text-sm text-fg placeholder:text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono text-[10px] text-muted sm:block">
          ⌘ K
        </kbd>
      </form>

      <div className="ml-auto flex items-center gap-1">
        <NotificationsMenu initialUnread={alertCount} iconBtn={iconBtn} />

        <LanguageSwitcher />
        <ThemeToggle className={iconBtn} />

        <SettingsMenu user={user} iconBtn={iconBtn} onSignOut={signOut} />

        <div className="ml-3 hidden items-center gap-3 sm:flex">
          {user ? (
            <>
              <div className="text-right leading-tight">
                <div className="text-sm font-medium text-fg">{user.displayName}</div>
                <div className="text-xs text-muted">{t.users.roles[user.role]}</div>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand to-indigo-500 text-sm font-bold text-white" aria-hidden>
                {user.displayName.charAt(0).toUpperCase()}
              </div>
              <button type="button" onClick={signOut} className={iconBtn} aria-label={t.auth.signOut} title={t.auth.signOut}>
                <LogOut className="h-[18px] w-[18px]" />
              </button>
            </>
          ) : (
            <Link href="/utilisateurs" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-xs font-medium text-warn hover:bg-warn/20">
              {t.auth.openBanner}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
