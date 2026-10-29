/**
 * Contrôle des adresses de webhook. Les réseaux privés et « localhost » restent permis (un webhook vers un outil interne,
 * n8n, un relais Slack, est le cas d'usage normal d'une PME) ; on bloque ce qui n'a aucun usage légitime et qui
 * exposerait les métadonnées du cloud : lien-local (169.254.0.0/16, fe80::/10), adresse non spécifiée, multicast.
 */
import { formatIp, ipInCidr, parseIp } from "../ip/cidr";
import { WEBHOOK_URL_MAX } from "../webhookTypes";

const BLOCKED_V4 = ["169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4"];
const BLOCKED_V6 = ["fe80::/10", "ff00::/8", "::/128", "fd00:ec2::254/128"];

/** Vrai si l'adresse IP (texte) ne doit jamais être jointe. */
export function isBlockedAddress(addr: string): boolean {
  const host = addr.replace(/^\[|\]$/g, "");
  const p = parseIp(host);
  if (!p) return false;
  // IPv4 écrite en IPv6 (::ffff:169.254.169.254, que l'analyse d'URL réécrit en ::ffff:a9fe:a9fe) : on contrôle l'IPv4 contenue
  if (p.version === 6 && p.value >> 32n === 0xffffn) return isBlockedAddress(formatIp(4, p.value & 0xffffffffn));
  const text = formatIp(p.version, p.value);
  return (p.version === 4 ? BLOCKED_V4 : BLOCKED_V6).some((c) => ipInCidr(text, c));
}

export type UrlProblem = "invalid" | "blocked";

/** null si l'adresse est acceptable. N'effectue aucune résolution DNS (voir le dispatcher pour le contrôle à l'envoi). */
export function checkWebhookUrl(raw: unknown): UrlProblem | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > WEBHOOK_URL_MAX) return "invalid";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";
  if (u.username || u.password || !u.hostname) return "invalid";
  if (isBlockedAddress(u.hostname)) return "blocked";
  return null;
}
