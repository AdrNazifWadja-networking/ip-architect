/**
 * Client LDAP v3 minimal (bind simple, recherche, StartTLS) sur node:net / node:tls, sans dépendance.
 *
 * - TLS : le certificat du serveur est TOUJOURS vérifié (ldaps:// ou StartTLS). Pour un annuaire d'entreprise dont le
 *   certificat est signé par une autorité interne, ajoutez-la au serveur avec la variable NODE_EXTRA_CA_CERTS.
 * - Un « bind » avec mot de passe vide est refusé côté client : la plupart des annuaires l'acceptent comme une connexion
 *   anonyme réussie (RFC 4513 § 5.1.2), ce qui laisserait n'importe qui entrer avec un identifiant valide.
 * - Une seule requête à la fois par connexion ; délai de 8 s par requête ; réponses limitées à 4 Mo.
 */
import net from "node:net";
import tls from "node:tls";
import { T, bool, children, int, octet, readTlv, tlv, toInt } from "./ber";
import { encodeFilter } from "./filter";

export class LdapError extends Error {
  constructor(
    public readonly kind: "connect" | "protocol" | "timeout" | "result" | "tls",
    message: string,
    public readonly resultCode?: number,
  ) {
    super(message);
  }
}

export const RESULT = { SUCCESS: 0, SIZE_LIMIT: 4, INVALID_CREDENTIALS: 49 } as const;
const STARTTLS_OID = "1.3.6.1.4.1.1466.20037";
const TIMEOUT_MS = 8_000;

export interface LdapEntry {
  dn: string;
  /** Nom d'attribut (en minuscules) -> valeurs texte (les valeurs binaires sont décodées en UTF-8 et peuvent être illisibles). */
  attrs: Record<string, string[]>;
}

export interface LdapConn {
  /** Résout si le « bind » réussit ; renvoie false si l'annuaire refuse les identifiants ; lève une LdapError pour toute autre panne. */
  bind(dn: string, password: string): Promise<boolean>;
  search(baseDn: string, filter: string, attributes: string[], sizeLimit?: number): Promise<LdapEntry[]>;
  close(): Promise<void>;
}

export interface LdapTarget {
  url: string;
  startTls: boolean;
}

/** Fabrique de connexions (injectable dans les tests). */
export type LdapConnect = (target: LdapTarget) => Promise<LdapConn>;

export function parseLdapUrl(url: string): { secure: boolean; host: string; port: number } | null {
  const m = /^(ldaps?):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(url.trim());
  if (!m) return null;
  const secure = m[1] === "ldaps";
  const port = m[3] ? Number(m[3]) : secure ? 636 : 389;
  if (port < 1 || port > 65535) return null;
  return { secure, host: m[2].replace(/^\[|\]$/g, ""), port };
}

class Connection implements LdapConn {
  private buf = Buffer.alloc(0);
  private msgId = 0;
  private waiter: { onMsg: (m: { id: number; op: number; body: Buffer }) => void; onErr: (e: Error) => void } | null = null;
  private error: Error | null = null;
  private queue: { id: number; op: number; body: Buffer }[] = [];

  constructor(private socket: net.Socket) {
    this.attach(socket);
  }

  private attach(s: net.Socket) {
    s.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      try {
        this.drain();
      } catch (e) {
        this.fail(e as Error);
      }
    });
    s.on("error", (e: Error) => this.fail(new LdapError("connect", e.message)));
    s.on("close", () => this.fail(new LdapError("connect", "connexion fermée par l'annuaire")));
  }

  private fail(e: Error) {
    if (!this.error) this.error = e;
    this.waiter?.onErr(e);
    this.waiter = null;
  }

  private drain() {
    for (;;) {
      const t = readTlv(this.buf);
      if (!t) return;
      this.buf = this.buf.subarray(t.next);
      if (t.tag !== T.SEQ) throw new LdapError("protocol", "message LDAP invalide");
      const parts = children(t.value);
      if (parts.length < 2 || parts[0].tag !== T.INTEGER) throw new LdapError("protocol", "message LDAP invalide");
      const msg = { id: toInt(parts[0].value), op: parts[1].tag, body: parts[1].value };
      if (this.waiter) this.waiter.onMsg(msg);
      else this.queue.push(msg);
    }
  }

  private next(): Promise<{ id: number; op: number; body: Buffer }> {
    if (this.error) return Promise.reject(this.error);
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const e = new LdapError("timeout", "délai dépassé");
        this.fail(e);
        reject(e);
      }, TIMEOUT_MS);
      this.waiter = {
        onMsg: (m) => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(m);
        },
        onErr: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  private send(op: Buffer): number {
    if (this.error) throw this.error;
    const id = ++this.msgId;
    this.socket.write(tlv(T.SEQ, int(id), op));
    return id;
  }

  private static result(body: Buffer): { code: number; diagnostic: string } {
    const p = children(body);
    if (p.length < 3 || p[0].tag !== T.ENUM) throw new LdapError("protocol", "réponse LDAP invalide");
    return { code: toInt(p[0].value), diagnostic: p[2].value.toString("utf8") };
  }

  async startTls(host: string): Promise<void> {
    const id = this.send(tlv(T.EXT_REQ, octet(STARTTLS_OID, 0x80)));
    const m = await this.next();
    if (m.id !== id || m.op !== T.EXT_RES) throw new LdapError("protocol", "réponse StartTLS inattendue");
    const r = Connection.result(m.body);
    if (r.code !== RESULT.SUCCESS) throw new LdapError("tls", `StartTLS refusé (${r.code})`, r.code);
    if (this.buf.length > 0) throw new LdapError("tls", "données reçues avant la fin de la négociation TLS");
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true }, () => resolve(s));
      s.once("error", (e) => reject(new LdapError("tls", e.message)));
    });
    this.socket = secure;
    this.attach(secure);
  }

  async bind(dn: string, password: string): Promise<boolean> {
    if (password === "") throw new LdapError("protocol", "mot de passe vide refusé");
    const id = this.send(tlv(T.BIND_REQ, int(3), octet(dn), octet(password, 0x80)));
    const m = await this.next();
    if (m.id !== id || m.op !== T.BIND_RES) throw new LdapError("protocol", "réponse « bind » inattendue");
    const r = Connection.result(m.body);
    if (r.code === RESULT.SUCCESS) return true;
    // identifiants refusés : « invalidCredentials » (49), mais aussi les variantes courantes (DN invalide, entrée absente, interdit)
    if ([RESULT.INVALID_CREDENTIALS, 32, 34, 50, 53].includes(r.code)) return false;
    throw new LdapError("result", `bind : code ${r.code} ${r.diagnostic}`.trim(), r.code);
  }

  async search(baseDn: string, filter: string, attributes: string[], sizeLimit = 2): Promise<LdapEntry[]> {
    const op = tlv(
      T.SEARCH_REQ,
      octet(baseDn),
      int(2, T.ENUM), // sous-arbre
      int(0, T.ENUM), // ne pas déréférencer les alias
      int(sizeLimit),
      int(8), // limite de temps (s)
      bool(false),
      encodeFilter(filter),
      tlv(T.SEQ, ...attributes.map((a) => octet(a))),
    );
    const id = this.send(op);
    const out: LdapEntry[] = [];
    for (;;) {
      const m = await this.next();
      if (m.id !== id) throw new LdapError("protocol", "réponse hors séquence");
      if (m.op === T.SEARCH_ENTRY) {
        const p = children(m.body);
        const attrs: Record<string, string[]> = {};
        for (const a of children(p[1].value)) {
          const [type, vals] = children(a.value);
          attrs[type.value.toString("utf8").toLowerCase()] = children(vals.value).map((v) => v.value.toString("utf8"));
        }
        out.push({ dn: p[0].value.toString("utf8"), attrs });
      } else if (m.op === T.SEARCH_REF) {
        continue; // renvois vers un autre serveur : ignorés
      } else if (m.op === T.SEARCH_DONE) {
        const r = Connection.result(m.body);
        if (r.code !== RESULT.SUCCESS && r.code !== RESULT.SIZE_LIMIT) throw new LdapError("result", `search : code ${r.code} ${r.diagnostic}`.trim(), r.code);
        return out;
      } else throw new LdapError("protocol", "réponse de recherche inattendue");
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.error) this.socket.write(tlv(T.SEQ, int(++this.msgId), tlv(T.UNBIND_REQ)));
    } catch {
      /* déjà fermée */
    }
    this.socket.destroy();
  }
}

/** Connexion réelle : ldaps:// (TLS direct), ldap:// puis StartTLS si demandé, ldap:// en clair sinon. */
export const connectLdap: LdapConnect = async ({ url, startTls }) => {
  const u = parseLdapUrl(url);
  if (!u) throw new LdapError("connect", "adresse LDAP invalide");
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.destroy();
      reject(new LdapError("timeout", "connexion : délai dépassé"));
    }, TIMEOUT_MS);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const s: net.Socket = u.secure
      ? tls.connect({ host: u.host, port: u.port, servername: net.isIP(u.host) ? undefined : u.host, rejectUnauthorized: true }, () => done(() => resolve(s)))
      : net.connect({ host: u.host, port: u.port }, () => done(() => resolve(s)));
    s.once("error", (e) => done(() => reject(new LdapError(u.secure ? "tls" : "connect", e.message))));
  });
  const conn = new Connection(socket);
  if (!u.secure && startTls) {
    try {
      await conn.startTls(u.host);
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }
  return conn;
};
