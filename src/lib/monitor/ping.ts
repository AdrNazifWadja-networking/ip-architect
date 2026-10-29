/**
 * Sonde de joignabilité : un « ping » par adresse inventoriée.
 *
 * Le serveur Next exécute la commande système `ping` (pas d'ICMP brut, donc aucun droit particulier) :
 * - jamais par un shell (execFile + arguments séparés) ;
 * - l'adresse est revalidée (IPv4/IPv6 strict) juste avant l'exécution : aucune chaîne libre n'atteint la commande ;
 * - une seule requête par adresse, 1 s d'attente, 8 sondes en parallèle, 64 adresses maximum par lancement.
 * Windows, Linux et macOS n'ont pas les mêmes options ni la même sortie : tout cela est isolé ici et testé.
 */
import { execFile } from "node:child_process";
import { parseIp } from "../ip/cidr";

export const MAX_PROBE_ADDRESSES = 64;
const CONCURRENCY = 8;
const TIMEOUT_MS = 1000;

export interface PingResult {
  alive: boolean;
  /** Temps de réponse en ms, quand la commande le donne. */
  ms: number | null;
}

export type Platform = NodeJS.Platform;

/** Programme et arguments de la commande ping pour cette plateforme et cette version d'IP. */
export function pingCommand(platform: Platform, version: 4 | 6, address: string): { cmd: string; args: string[] } {
  if (platform === "win32") {
    return { cmd: "ping", args: ["-n", "1", "-w", String(TIMEOUT_MS), ...(version === 6 ? ["-6"] : ["-4"]), address] };
  }
  if (platform === "darwin") {
    // macOS : -W est en millisecondes ; l'IPv6 passe par ping6
    return version === 6
      ? { cmd: "ping6", args: ["-c", "1", address] }
      : { cmd: "ping", args: ["-c", "1", "-W", String(TIMEOUT_MS), address] };
  }
  // Linux et autres : -W en secondes
  return { cmd: "ping", args: ["-c", "1", "-W", String(Math.max(1, Math.round(TIMEOUT_MS / 1000))), ...(version === 6 ? ["-6"] : []), address] };
}

const TIME_RE = /(?:time|temps|zeit|tiempo)\s*[=<]\s*([\d.,]+)\s*ms/i;
const FAILURE_RE = /unreachable|injoignable|inaccessible|timed out|expir|100% packet loss|100(?:\.0)?% (?:de )?perte|no answer|general failure/i;

/**
 * Interprète le résultat de la commande.
 * Windows renvoie le code 0 même pour « Destination host unreachable » : on exige donc « TTL= » en IPv4
 * (absent en IPv6, où l'on vérifie l'absence de message d'échec).
 */
export function parsePing(platform: Platform, version: 4 | 6, exitCode: number, stdout: string): PingResult {
  const m = TIME_RE.exec(stdout);
  const ms = m ? Number(m[1].replace(",", ".")) : null;
  if (exitCode !== 0) return { alive: false, ms: null };
  if (platform === "win32") {
    const alive = version === 4 ? /TTL=/i.test(stdout) : !FAILURE_RE.test(stdout) && ms !== null;
    return { alive, ms: alive ? ms : null };
  }
  return { alive: true, ms };
}

export class PingUnavailableError extends Error {}

type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const realExec: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) });
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
      if (e.code === "ENOENT") return reject(new PingUnavailableError(cmd));
      // code de sortie non nul ou délai dépassé : l'adresse ne répond pas
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: String(stdout ?? "") });
    });
  });

/** Ping d'une adresse. Une adresse invalide n'exécute RIEN. */
export async function ping(address: string, platform: Platform = process.platform, exec: ExecFn = realExec): Promise<PingResult> {
  const parsed = parseIp(address);
  if (!parsed) return { alive: false, ms: null };
  const { cmd, args } = pingCommand(platform, parsed.version, address);
  const out = await exec(cmd, args, TIMEOUT_MS + 2000);
  return parsePing(platform, parsed.version, out.code, out.stdout);
}

/** Pings en parallèle limité, dans l'ordre d'entrée. Propage PingUnavailableError si la commande n'existe pas. */
export async function pingMany(
  addresses: string[],
  platform: Platform = process.platform,
  exec: ExecFn = realExec,
): Promise<PingResult[]> {
  const results: PingResult[] = new Array(addresses.length);
  let next = 0;
  const worker = async () => {
    while (next < addresses.length) {
      const i = next++;
      results[i] = await ping(addresses[i], platform, exec);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
  return results;
}
