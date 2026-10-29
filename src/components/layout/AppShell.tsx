"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import type { SessionUser } from "@/lib/types";
import { useI18n } from "@/lib/i18n/client";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { StatusFooter } from "./StatusFooter";

interface Props {
  projectName: string;
  alertCount: number;
  /** Utilisateur connecté (null = application ouverte, ou page de connexion). */
  user: SessionUser | null;
  /** Connexion exigée mais absente : pas de menu ni d'en-tête (page de connexion). */
  locked: boolean;
  children: React.ReactNode;
}

export function AppShell({ projectName, alertCount, user, locked, children }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // page de connexion (ou session expirée) : contenu seul, sans menu ni en-tête
  if (locked || pathname === "/login" || pathname === "/inscription" || pathname === "/mot-de-passe-oublie") {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar projectName={projectName} open={open} onNavigate={() => setOpen(false)} />

      {/* Fond assombri derrière le menu sur mobile */}
      {open && (
        <button
          aria-label={t.header.toggleMenu}
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Header alertCount={alertCount} user={user} onToggleSidebar={() => setOpen((o) => !o)} />
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">{children}</main>
        <StatusFooter />
      </div>
    </div>
  );
}
