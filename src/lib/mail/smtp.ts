/**
 * Client SMTP minimal, sans dépendance (node:net / node:tls) : un message texte, une adresse destinataire.
 *
 * - « tls » : connexion chiffrée d'emblée (port 465). « starttls » : chiffrement négocié (port 587), REFUSÉ s'il n'est pas
 *   proposé par le serveur (pas de repli en clair). « none » : uniquement vers la machine locale (tests, MailHog).
 * - Les identifiants ne sont envoyés qu'après chiffrement. Le certificat du serveur est TOUJOURS vérifié.
 * - Adresses validées (ASCII, sans retour à la ligne) : pas d'injection d'en-têtes. Corps encodé en base64.
 * - Délais bornés. Les réponses du serveur ne sont jamais renvoyées à l'utilisateur (tracées tronquées, sans identifiants).
 */
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { isLoopback, normalizeEmail, type SmtpSecurity } from "../signupTypes";

export interface SmtpEndpoint {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: string;
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Réservé aux tests : certificat de confiance, délai court. */
export interface SmtpHooks {
  tls?: tls.ConnectionOptions;
  timeoutMs?: number;
}

export type SmtpFailure = "unreachable" | "tls" | "auth" | "timeout" | "rejected" | "protocol";

export class SmtpError extends Error {
  constructor(
    public kind: SmtpFailure,
    detail = "",
  ) {
    super(`${kind}${detail ? `: ${detail}` : ""}`);
  }
}

interface Reply {
  code: number;
  lines: string[];
}

class Conn {
  private buf = "";
  private queue: Reply[] = [];
  private partial: string[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(
    public socket: net.Socket | tls.TLSSocket,
    private timeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("timeout", () => this.fail(new SmtpError("timeout")));
    socket.on("error", (e: NodeJS.ErrnoException) => this.fail(classify(e)));
    socket.on("close", () => this.fail(new SmtpError("protocol", "connexion fermée par le serveur")));
  }

  private fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    this.socket.destroy();
    this.waiting?.reject(e);
    this.waiting = null;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > 100_000) return this.fail(new SmtpError("protocol", "réponse démesurée"));
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.partial.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      if (!m) return this.fail(new SmtpError("protocol", "réponse illisible"));
      if (m[2] === " ") {
        const reply = { code: Number(m[1]), lines: this.partial };
        this.partial = [];
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w.resolve(reply);
        } else this.queue.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  write(data: string) {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  async cmd(line: string): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.read();
  }

  close() {
    this.socket.destroy();
  }
}

function classify(e: NodeJS.ErrnoException): SmtpError {
  const c = e.code ?? "";
  if (c === "ETIMEDOUT") return new SmtpError("timeout");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|ERR_TLS|ERR_SSL|DEPTH_ZERO|WRONG_VERSION/.test(c) || /certificate|tls|ssl/i.test(e.message)) {
    return new SmtpError("tls", c || e.message.slice(0, 80));
  }
  return new SmtpError("unreachable", c || e.message.slice(0, 80));
}

const expect = (r: Reply, ok: number[], kind: SmtpFailure = "rejected") => {
  if (!ok.includes(r.code)) throw new SmtpError(kind, `${r.code} ${(r.lines[0] ?? "").slice(4, 100)}`);
  return r;
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Sujet : ASCII tel quel, sinon mots encodés RFC 2047 (jamais de retour à la ligne venant de la donnée). */
export function encodeSubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const chars = Array.from(s);
  const words: string[] = [];
  for (let i = 0; i < chars.length; i += 10) words.push(`=?UTF-8?B?${b64(chars.slice(i, i + 10).join(""))}?=`);
  return words.join("\r\n ");
}

export function buildMessage(from: string, msg: MailMessage, now: Date = new Date()): string {
  const domain = from.slice(from.indexOf("@") + 1);
  const body = (b64(msg.text.replace(/\r?\n/g, "\r\n")).match(/.{1,76}/g) ?? []).join("\r\n");
  return [
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `From: IP Architect <${from}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeSubject(msg.subject)}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

function connect(ep: SmtpEndpoint, hooks: SmtpHooks, timeoutMs: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const onErr = (e: NodeJS.ErrnoException) => reject(classify(e));
    const sock =
      ep.security === "tls"
        ? tls.connect({ host: ep.host, port: ep.port, servername: net.isIP(ep.host) ? undefined : ep.host, ...hooks.tls }, () => resolve(new Conn(sock, timeoutMs)))
        : net.connect({ host: ep.host, port: ep.port }, () => resolve(new Conn(sock, timeoutMs)));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new SmtpError("timeout"));
    });
    sock.once("error", onErr);
  });
}

/** Envoie le message. Lève SmtpError (jamais d'identifiants dans le message). */
export async function sendMail(ep: SmtpEndpoint, msg: MailMessage, hooks: SmtpHooks = {}): Promise<void> {
  const to = normalizeEmail(msg.to);
  const from = normalizeEmail(ep.from);
  if (!to || !from) throw new SmtpError("rejected", "adresse invalide");
  if (ep.security === "none" && !isLoopback(ep.host)) throw new SmtpError("tls", "connexion non chiffrée refusée");
  const timeoutMs = hooks.timeoutMs ?? 15_000;

  let conn = await connect(ep, hooks, timeoutMs);
  const overall = setTimeout(() => conn.close(), Math.max(timeoutMs * 2, 30_000));
  try {
    expect(await conn.read(), [220], "protocol");
    let caps = parseCaps(expect(await conn.cmd("EHLO ip-architect"), [250], "protocol"));
    if (ep.security === "starttls") {
      if (!caps.has("STARTTLS")) throw new SmtpError("tls", "STARTTLS non proposé : envoi refusé en clair");
      expect(await conn.cmd("STARTTLS"), [220], "tls");
      const upgraded = tls.connect({ socket: conn.socket as net.Socket, servername: net.isIP(ep.host) ? undefined : ep.host, ...hooks.tls });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", (e) => reject(classify(e as NodeJS.ErrnoException)));
      });
      upgraded.removeAllListeners("error");
      conn = new Conn(upgraded, timeoutMs);
      caps = parseCaps(expect(await conn.cmd("EHLO ip-architect"), [250], "protocol"));
    }
    if (ep.user) {
      const auth = caps.get("AUTH") ?? "";
      if (/\bPLAIN\b/.test(auth)) {
        expect(await conn.cmd(`AUTH PLAIN ${b64(`\0${ep.user}\0${ep.password}`)}`), [235], "auth");
      } else if (/\bLOGIN\b/.test(auth)) {
        expect(await conn.cmd("AUTH LOGIN"), [334], "auth");
        expect(await conn.cmd(b64(ep.user)), [334], "auth");
        expect(await conn.cmd(b64(ep.password)), [235], "auth");
      } else throw new SmtpError("auth", "aucune méthode d'authentification compatible");
    }
    expect(await conn.cmd(`MAIL FROM:<${from}>`), [250]);
    expect(await conn.cmd(`RCPT TO:<${to}>`), [250, 251]);
    expect(await conn.cmd("DATA"), [354]);
    conn.write(`${buildMessage(from, { ...msg, to })}\r\n.\r\n`);
    expect(await conn.read(), [250]);
    try {
      await conn.cmd("QUIT");
    } catch {
      /* sans importance : le message est accepté */
    }
  } finally {
    clearTimeout(overall);
    conn.close();
  }
}

function parseCaps(r: Reply): Map<string, string> {
  const caps = new Map<string, string>();
  for (const l of r.lines.slice(1)) {
    const t = l.slice(4).trim();
    const sp = t.indexOf(" ");
    caps.set((sp < 0 ? t : t.slice(0, sp)).toUpperCase(), sp < 0 ? "" : t.slice(sp + 1).toUpperCase());
  }
  return caps;
}
