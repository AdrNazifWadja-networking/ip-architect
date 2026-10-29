/**
 * Client SNMP v2c en lecture seule (UDP, node:dgram), sans dépendance.
 *
 * - GET et GETBULK (repli GETNEXT) ; `walk` parcourt un sous-arbre avec plafonds de lignes et de durée.
 * - v2c : la « communauté » circule EN CLAIR et ne protège rien. À réserver à un réseau d'administration.
 * - Une communauté fausse ne reçoit aucune réponse : cela se voit comme un délai dépassé.
 * - Une réponse n'est acceptée que si elle vient de l'adresse interrogée, avec le bon identifiant de requête et la bonne communauté.
 */
import dgram from "node:dgram";
import { randomInt } from "node:crypto";
import { decodeResponse, encodeRequest, oidCompare, oidUnder, SnmpError, type Request, type Response, type VarBind } from "./codec";

export interface SnmpLike {
  get(oids: string[]): Promise<VarBind[]>;
  /** Toutes les variables sous `prefix`, dans l'ordre. */
  walk(prefix: string): Promise<VarBind[]>;
  close(): void;
}

export interface SnmpOptions {
  host: string;
  port?: number;
  community: string;
  timeoutMs?: number;
  retries?: number;
  /** Lignes lues au plus par `walk`. */
  maxRows?: number;
  /** Durée maximale d'un `walk`. */
  walkMs?: number;
}

export const SNMP_MAX_ROWS = 5000;

export class SnmpClient implements SnmpLike {
  private socket: dgram.Socket | null = null;
  private pending = new Map<number, (r: Response) => void>();
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private maxRep = 25;

  constructor(private readonly o: SnmpOptions) {
    this.port = o.port ?? 161;
    this.timeoutMs = o.timeoutMs ?? 2000;
    this.retries = o.retries ?? 1;
  }

  private open(): dgram.Socket {
    if (this.socket) return this.socket;
    const s = dgram.createSocket("udp4");
    s.on("message", (msg, rinfo) => {
      if (rinfo.address !== this.o.host || rinfo.port !== this.port) return;
      try {
        const r = decodeResponse(msg);
        if (r.community !== this.o.community) return;
        const done = this.pending.get(r.requestId);
        if (done) done(r);
      } catch {
        /* datagramme inattendu : ignoré */
      }
    });
    s.on("error", () => {});
    s.unref(); // un client oublié ne retient jamais le processus
    this.socket = s;
    return s;
  }

  private async send(req: Omit<Request, "community" | "requestId">): Promise<Response> {
    const sock = this.open();
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const requestId = randomInt(1, 0x7fffffff);
      const packet = encodeRequest({ ...req, community: this.o.community, requestId });
      const res = await new Promise<Response | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          resolve(null);
        }, this.timeoutMs);
        this.pending.set(requestId, (r) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(r);
        });
        sock.send(packet, this.port, this.o.host, (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            resolve(null);
          }
        });
      });
      if (res) return res;
    }
    throw new SnmpError("timeout", "aucune réponse (adresse injoignable, SNMP désactivé, ou communauté fausse)");
  }

  async get(oids: string[]): Promise<VarBind[]> {
    const r = await this.send({ kind: "get", oids });
    if (r.errorStatus === 1) throw new SnmpError("tooBig", "réponse trop grande");
    if (r.errorStatus !== 0) throw new SnmpError("refused", `erreur SNMP ${r.errorStatus}`);
    return r.varbinds;
  }

  async walk(prefix: string): Promise<VarBind[]> {
    const out: VarBind[] = [];
    const maxRows = this.o.maxRows ?? SNMP_MAX_ROWS;
    const deadline = Date.now() + (this.o.walkMs ?? 30_000);
    let cur = prefix;
    let useBulk = true;
    for (;;) {
      if (Date.now() > deadline) throw new SnmpError("timeout", "parcours trop long");
      let r: Response;
      try {
        r = await this.send(useBulk ? { kind: "getbulk", oids: [cur], maxRepetitions: this.maxRep } : { kind: "getnext", oids: [cur] });
      } catch (e) {
        if (e instanceof SnmpError && e.kind === "timeout" && useBulk && out.length === 0) {
          useBulk = false; // certains agents ignorent GETBULK
          continue;
        }
        throw e;
      }
      if (r.errorStatus === 1 && this.maxRep > 1) {
        this.maxRep = Math.max(1, Math.floor(this.maxRep / 2));
        continue;
      }
      if (r.errorStatus !== 0) {
        if (r.errorStatus === 2) return out; // noSuchName : fin du sous-arbre pour un agent v1
        throw new SnmpError("refused", `erreur SNMP ${r.errorStatus}`);
      }
      if (r.varbinds.length === 0) return out;
      for (const v of r.varbinds) {
        if (v.type === "end" || !oidUnder(v.oid, prefix)) return out;
        if (oidCompare(v.oid, cur) <= 0) throw new SnmpError("protocol", "l'agent ne progresse pas (OID qui ne croît pas)");
        out.push(v);
        cur = v.oid;
        if (out.length >= maxRows) return out;
      }
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.pending.clear();
  }
}
