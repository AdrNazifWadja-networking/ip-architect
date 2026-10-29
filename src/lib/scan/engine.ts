/**
 * Moteur de scan : ping (ICMP) et connexions TCP, en parallèle limité, avec annulation et DNS inverse.
 * Tout ce qui touche au réseau est injectable (tests sans réseau).
 *
 * - Un hôte « répond » s'il répond au ping, accepte une connexion TCP, OU REFUSE la connexion (un RST prouve qu'il est là).
 * - Aucune donnée n'est envoyée : on ouvre puis on referme la connexion.
 * - Le nom DNS inverse est une donnée d'un tiers : il n'est gardé que s'il ressemble à un nom d'hôte.
 */
import net from "node:net";
import { Resolver } from "node:dns/promises";
import { execFile } from "node:child_process";
import { ping as realPing, PingUnavailableError, type PingResult } from "../monitor/ping";
import type { ScanHost, ScanOptions } from "../scanTypes";

const HOST_CONCURRENCY = 32;
const TCP_TIMEOUT_MS = 600;
const DNS_TIMEOUT_MS = 1500;
const DNS_CONCURRENCY = 8;

export type TcpResult = "open" | "refused" | "none";

export interface ScanDeps {
  ping?: (address: string) => Promise<PingResult>;
  tcp?: (address: string, port: number) => Promise<TcpResult>;
  reverse?: (address: string) => Promise<string[]>;
  /** Table des voisins (IPv4 -> MAC) du serveur. */
  neighbors?: () => Promise<Map<string, string>>;
}

export const realTcp = (address: string, port: number): Promise<TcpResult> =>
  new Promise((resolve) => {
    const s = net.connect({ host: address, port });
    const done = (r: TcpResult) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(TCP_TIMEOUT_MS, () => done("none"));
    s.once("connect", () => done("open"));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" ? "refused" : "none"));
  });

/** Normalise une MAC (« a:B:c… », « aa-bb-… ») en « aa:bb:… » ; null si inutilisable (nulle, diffusion, multicast). */
export function normalizeMac(raw: string): string | null {
  const parts = raw.split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-fA-F]{1,2}$/.test(p))) return null;
  const octets = parts.map((p) => p.padStart(2, "0").toLowerCase());
  const mac = octets.join(":");
  if (mac === "00:00:00:00:00:00" || mac === "ff:ff:ff:ff:ff:ff" || (parseInt(octets[0], 16) & 1) === 1) return null;
  return mac;
}

/** Sortie de « ip neigh », « arp -an » (Linux, macOS) ou « arp -a » (Windows) -> IPv4 -> MAC. Les entrées incomplètes sont ignorées. */
export function parseNeighbors(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})\D[^\n]*?\b([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})\b/.exec(line);
    if (!m) continue;
    const mac = normalizeMac(m[2]);
    if (mac && m[1].split(".").every((o) => Number(o) <= 255)) out.set(m[1], mac);
  }
  return out;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });

/** Voisins connus du serveur : seuls les hôtes du MÊME réseau local y figurent (un hôte derrière un routeur n'a pas de MAC ici). */
export async function realNeighbors(platform: NodeJS.Platform = process.platform): Promise<Map<string, string>> {
  const attempts: [string, string[]][] = platform === "win32" ? [["arp", ["-a"]]] : platform === "darwin" ? [["arp", ["-an"]]] : [["ip", ["-4", "neigh", "show"]], ["arp", ["-an"]]];
  for (const [cmd, args] of attempts) {
    const m = parseNeighbors(await run(cmd, args));
    if (m.size > 0) return m;
  }
  return new Map();
}

const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
const realReverse = (address: string) => resolver.reverse(address);

/** Premier nom plausible (lettres, chiffres, point, tiret, souligné ; 100 caractères au plus), sans point final. */
export function cleanHostname(names: readonly string[]): string | null {
  for (const raw of names) {
    const n = raw.trim().replace(/\.$/, "");
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n)) return n;
  }
  return null;
}

export interface ScanProgress {
  done: number;
  alive: number;
}

export interface ScanOutcome {
  hosts: ScanHost[];
  cancelled: boolean;
  notes: string[];
}

async function pool<T>(items: readonly T[], size: number, signal: AbortSignal, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

export async function runScan(
  targets: readonly string[],
  opts: ScanOptions,
  signal: AbortSignal,
  onProgress: (p: ScanProgress) => void = () => {},
  deps: ScanDeps = {},
): Promise<ScanOutcome> {
  const doPing = deps.ping ?? realPing;
  const doTcp = deps.tcp ?? realTcp;
  const found = new Map<string, ScanHost>();
  const notes: string[] = [];
  let icmp = opts.icmp;
  let done = 0;

  await pool(targets, HOST_CONCURRENCY, signal, async (address) => {
    const via: string[] = [];
    let ms: number | null = null;
    if (icmp) {
      try {
        const r = await doPing(address);
        if (r.alive) {
          via.push("icmp");
          ms = r.ms;
        }
      } catch (e) {
        if (!(e instanceof PingUnavailableError)) throw e;
        icmp = false; // pas de commande ping sur ce serveur : on continue avec les ports
        if (!notes.includes("icmpUnavailable")) notes.push("icmpUnavailable");
      }
    }
    if (opts.ports.length > 0 && !signal.aborted) {
      const res = await Promise.all(opts.ports.map((p) => doTcp(address, p)));
      opts.ports.forEach((p, i) => {
        if (res[i] === "open") via.push(`tcp:${p}`);
      });
      if (res.includes("refused") && !via.some((v) => v.startsWith("tcp:"))) via.push("tcp-refused");
    }
    if (via.length > 0) found.set(address, { address, ms, via, hostname: null, mac: null });
    done++;
    onProgress({ done, alive: found.size });
  });

  const cancelled = signal.aborted;
  const hosts = [...found.values()];
  if (hosts.length > 0) {
    // la table des voisins se remplit pendant le scan (chaque ping ou connexion déclenche une résolution ARP)
    try {
      const nb = await (deps.neighbors ?? realNeighbors)();
      for (const h of hosts) h.mac = nb.get(h.address) ?? null;
    } catch {
      /* facultatif : pas de MAC */
    }
  }
  if (opts.resolve && hosts.length > 0 && !cancelled) {
    const rev = deps.reverse ?? realReverse;
    await pool(hosts, DNS_CONCURRENCY, signal, async (h) => {
      try {
        h.hostname = cleanHostname(await rev(h.address));
      } catch {
        h.hostname = null; // pas d'enregistrement inverse : normal
      }
    });
  }
  return { hosts: hosts.sort((a, b) => ipNum(a.address) - ipNum(b.address)), cancelled, notes };
}

const ipNum = (a: string): number => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
