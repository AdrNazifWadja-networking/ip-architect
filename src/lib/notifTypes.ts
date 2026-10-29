/** Types des notifications, sans accès à la base : importables côté navigateur. */
import type { FindingKind, FindingSeverity } from "./db/monitoring";

export const NOTIF_MAX_ITEMS = 30;
export const NOTIF_MAX_READ_IDS = 200;

export interface NotificationItem {
  /** Empreinte stable du contrôle (projet + type + objet) : sert à marquer « lu ». */
  id: string;
  kind: FindingKind;
  severity: Exclude<FindingSeverity, "info">;
  params: Record<string, string | number>;
  href: string;
  read: boolean;
}

export interface NotificationsData {
  /** Contrôles critiques et avertissements en cours, les non lus d'abord (au plus NOTIF_MAX_ITEMS). */
  items: NotificationItem[];
  /** Nombre de non lus (tous, pas seulement ceux listés). */
  unread: number;
  /** Nombre total de contrôles critiques ou avertissements. */
  total: number;
}
