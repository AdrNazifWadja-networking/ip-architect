"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronDown, ChevronRight, Waypoints } from "lucide-react";
import { NAV } from "@/lib/nav";
import { useI18n } from "@/lib/i18n/client";

interface Props {
  projectName: string;
  open: boolean;
  onNavigate: () => void;
}

export function Sidebar({ projectName, open, onNavigate }: Props) {
  const pathname = usePathname();
  const { t } = useI18n();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-[238px] flex-col border-r border-line bg-bg transition-transform lg:static lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      {/* Logo */}
      <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-indigo-500">
          <Waypoints className="h-4 w-4 text-white" />
        </div>
        <span className="text-[17px] font-bold tracking-wide text-fg">IP ARCHITECT</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {/* Projet actif */}
        <Link
          href="/projets"
          onClick={onNavigate}
          title={t.nav.projectSwitch}
          className="mt-4 block rounded-lg border border-line bg-panel px-3 py-2 transition-colors hover:border-brand/50"
        >
          <div className="label-caps text-[9.5px]">{t.nav.activeProject}</div>
          <div className="flex items-center justify-between">
            <span className="truncate text-sm font-semibold text-fg">{projectName}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
          </div>
        </Link>

        {NAV.map((section) => (
          <nav key={section.key} className="mt-5" aria-label={t.nav.sections[section.key]}>
            <div className="label-caps mb-1.5 px-3 text-[10px]">{t.nav.sections[section.key]}</div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? "bg-brand/15 font-medium text-fg"
                          : item.ready
                            ? "text-fg2 hover:bg-panel2 hover:text-fg"
                            : "text-muted hover:bg-panel hover:text-fg2"
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${active ? "text-brand-soft" : ""}`} />
                      {t.nav.items[item.key]}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ))}
      </div>

      {/* Aide */}
      <div className="shrink-0 p-3">
        <Link
          href="/documentation"
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2.5 hover:bg-brand/20"
        >
          <BookOpen className="h-5 w-5 text-brand-soft" />
          <div className="flex-1 leading-tight">
            <div className="text-[11px] text-brand-soft">{t.nav.needHelp}</div>
            <div className="text-sm font-medium text-fg">{t.nav.documentation}</div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted" />
        </Link>
      </div>
    </aside>
  );
}
