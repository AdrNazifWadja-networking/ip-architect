import {
  Boxes,
  Calculator,
  CalendarClock,
  FileBarChart,
  FlaskConical,
  GraduationCap,
  FolderKanban,
  KeyRound,
  Search,
  ShieldCheck,
  Globe,
  LayoutDashboard,
  MapPin,
  Network,
  Radar,
  ScrollText,
  Webhook,
  Settings,
  ListTree,
  Share2,
  Sparkles,
  Tag,
  Upload,
  Users,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { Dictionary } from "./i18n";

export type NavItemKey = keyof Dictionary["nav"]["items"];
export type NavSectionKey = keyof Dictionary["nav"]["sections"];

export interface NavItem {
  /** clé de traduction dans nav.items */
  key: NavItemKey;
  href: string;
  icon: LucideIcon;
  /** false = module prévu, la page affiche un écran "en préparation" */
  ready: boolean;
}

export interface NavSection {
  /** clé de traduction dans nav.sections */
  key: NavSectionKey;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    key: "general",
    items: [
      { key: "dashboard", href: "/", icon: LayoutDashboard, ready: true },
      { key: "projects", href: "/projets", icon: FolderKanban, ready: true },
      { key: "sites", href: "/sites", icon: MapPin, ready: true },
      { key: "networks", href: "/reseaux", icon: Network, ready: true },
      { key: "vlans", href: "/vlans", icon: Boxes, ready: true },
      { key: "ipam", href: "/ipam", icon: Share2, ready: true },
      { key: "dhcp", href: "/dhcp", icon: Wifi, ready: true },
      { key: "vrf", href: "/vrf", icon: Globe, ready: true },
      { key: "monitoring", href: "/supervision", icon: Radar, ready: true },
      { key: "reports", href: "/rapports", icon: FileBarChart, ready: true },
      { key: "tags", href: "/etiquettes", icon: Tag, ready: true },
      { key: "tree", href: "/arborescence", icon: ListTree, ready: true },
    ],
  },
  {
    key: "tools",
    items: [
      { key: "calculator", href: "/calculateur", icon: Calculator, ready: true },
      { key: "planning", href: "/planification", icon: CalendarClock, ready: true },
      { key: "simulator", href: "/simulateur", icon: FlaskConical, ready: true },
      { key: "tp", href: "/tp", icon: GraduationCap, ready: true },
      { key: "aiAssistant", href: "/assistant-ia", icon: Sparkles, ready: true },
      { key: "scan", href: "/scan", icon: Search, ready: true },
      { key: "topology", href: "/topologie", icon: Share2, ready: true },
      { key: "importExport", href: "/import-export", icon: Upload, ready: true },
    ],
  },
  {
    key: "settings",
    items: [
      { key: "users", href: "/utilisateurs", icon: Users, ready: true },
      { key: "settings", href: "/parametres", icon: Settings, ready: true },
      { key: "auditLogs", href: "/audit-logs", icon: ScrollText, ready: true },
      { key: "apiTokens", href: "/jetons-api", icon: KeyRound, ready: true },
      { key: "webhooks", href: "/webhooks", icon: Webhook, ready: true },
      { key: "sso", href: "/authentification", icon: ShieldCheck, ready: true },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((s) => s.items);

/** Les URL restent identiques dans toutes les langues ; seules les étiquettes changent. */
export function labelKeyForSlug(slug: string): NavItemKey | null {
  return ALL_ITEMS.find((i) => i.href === `/${slug}`)?.key ?? null;
}
