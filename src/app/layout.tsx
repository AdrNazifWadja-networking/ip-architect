import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/ThemeProvider";
import { I18nProvider } from "@/lib/i18n/client";
import { getDictionary } from "@/lib/i18n/server";
import { getActiveProject } from "@/lib/db/queries";
import { getNotifications } from "@/lib/db/notifications";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { currentUser } from "@/lib/auth/guard";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

// Les données viennent de SQLite et la langue du cookie : jamais de pré-rendu statique.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const { t } = getDictionary();
  return { title: t.meta.title, description: t.meta.description };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale } = getDictionary();
  // Connexion exigée et absente : on n'envoie AUCUNE donnée du projet au navigateur (le nom du projet, le nombre d'alertes)
  const user = currentUser();
  const locked = authEnabled(getDb()) && !user;
  let projectName = "";
  let alertCount = 0;
  if (!locked) {
    try {
      projectName = getActiveProject().name;
      // pastille de la cloche : contrôles de supervision non lus de CE compte (calculés sur les données réelles)
      alertCount = getNotifications(user?.id).unread;
    } catch {
      // compte « à projets choisis » sans aucun projet : pas de nom de projet ni de pastille (la page /aucun-projet l'explique)
    }
  }

  return (
    // suppressHydrationWarning : le script ci-dessous ajoute la classe "dark" avant l'hydratation
    <html lang={locale} className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <I18nProvider locale={locale}>
          <ThemeProvider>
            <AppShell projectName={projectName} alertCount={alertCount} user={user} locked={locked}>
              {children}
            </AppShell>
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
