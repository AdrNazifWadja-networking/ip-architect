/** Alertes par e-mail : types partagés serveur / navigateur. */
export const ALERT_SEVERITIES = ["critical", "warning"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_MIN_INTERVAL_MIN = 5;
export const ALERT_MAX_INTERVAL_MIN = 1440;
export const ALERT_DEFAULT_INTERVAL_MIN = 15;
export const ALERT_MAX_RECIPIENTS = 20;
/** Nombre maximal de lignes détaillées dans un e-mail (le reste est résumé en « … et N autres »). */
export const ALERT_MAX_LINES = 50;

export interface AlertRunResult {
  at: string;
  /** Nouveaux problèmes trouvés à ce passage. */
  fresh: number;
  /** Destinataires à qui le message est parti. */
  sent: number;
  /** Code d'erreur d'envoi, s'il y en a eu (le prochain passage réessaie). */
  error: string | null;
}

export interface AlertConfig {
  enabled: boolean;
  recipients: string[];
  minSeverity: AlertSeverity;
  intervalMin: number;
  locale: "fr" | "en";
  /** Destinataires propres à chaque projet (en plus des destinataires communs) : un contact par client, par exemple. */
  projectRecipients: { projectId: number; name: string; recipients: string[] }[];
  lastRun: AlertRunResult | null;
  /** L'envoi d'e-mails (SMTP ou mode console) est configuré : sans lui, aucune alerte ne peut partir. */
  mailReady: boolean;
}

export interface UpdateAlertConfigInput {
  enabled?: boolean;
  recipients?: string[] | string;
  minSeverity?: string;
  intervalMin?: number;
  locale?: string;
  /** Remplace les destinataires des projets cités (liste vide = aucun destinataire propre) ; les autres projets sont inchangés. */
  projectRecipients?: { projectId: number; recipients: string[] | string }[];
}
