/** Faux équipement SNMP pour les tests : une MIB en mémoire, utilisable directement (SnmpLike) ou derrière un vrai socket UDP. */
import dgram from "node:dgram";
import { children, int, octet, readTlv, tlv, toInt } from "../ldap/ber";
import { decodeOid, encodeOid, oidCompare, TAG, type ValueType, type VarBind } from "./codec";
import type { SnmpLike } from "./client";

export const str = (s: string | Buffer): { type: ValueType; value: Buffer } => ({ type: "str", value: Buffer.isBuffer(s) ? s : Buffer.from(s) });
export const num = (n: number): { type: ValueType; value: Buffer } => ({ type: "int", value: int(n).subarray(2) });
export const ipv4 = (a: string): { type: ValueType; value: Buffer } => ({ type: "ip", value: Buffer.from(a.split(".").map(Number)) });
export const objId = (o: string): { type: ValueType; value: Buffer } => ({ type: "oid", value: encodeOid(o).subarray(2) });
export const mac = (m: string): Buffer => Buffer.from(m.split(":").map((x) => parseInt(x, 16)));

type Entry = { type: ValueType; value: Buffer };

export class MibStore implements SnmpLike {
  readonly oids: string[];
  /** Nombre de requêtes servies (les tests s'en servent pour vérifier qu'on ne boucle pas). */
  requests = 0;
  constructor(private readonly mib: Record<string, Entry>) {
    this.oids = Object.keys(mib).sort(oidCompare);
  }
  next(oid: string): VarBind | null {
    const o = this.oids.find((x) => oidCompare(x, oid) > 0);
    return o ? { oid: o, ...this.mib[o] } : null;
  }
  async get(oids: string[]): Promise<VarBind[]> {
    this.requests++;
    return oids.map((o) => (this.mib[o] ? { oid: o, ...this.mib[o] } : { oid: o, type: "missing" as const, value: Buffer.alloc(0) }));
  }
  async walk(prefix: string): Promise<VarBind[]> {
    this.requests++;
    return this.oids.filter((o) => o.startsWith(prefix + ".")).map((o) => ({ oid: o, ...this.mib[o] }));
  }
  close(): void {}
}

const TAG_OF: Record<string, number> = { int: TAG.INTEGER, uint: TAG.GAUGE32, str: TAG.OCTET, oid: TAG.OID, ip: TAG.IPADDRESS, null: TAG.NULL };

/** Serveur UDP sur 127.0.0.1 (port libre) : GET, GETNEXT et GETBULK ; une mauvaise communauté ne reçoit aucune réponse. */
export function serveUdp(store: MibStore, community: string): Promise<{ port: number; close: () => void; seen: string[] }> {
  const seen: string[] = [];
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    try {
      const m = readTlv(msg)!;
      const [ver, comm, pdu] = children(m.value);
      if (comm.value.toString("latin1") !== community) return;
      const [rid, a, b, binds] = children(pdu.value);
      const reps = toInt(b.value);
      const oidsIn = children(binds.value).map((x) => decodeOid(children(x.value)[0].value));
      const out: Buffer[] = [];
      const push = (oid: string, e: { type: ValueType; value: Buffer } | null, missing = false) => {
        const val = e ? tlv(TAG_OF[e.type] ?? TAG.OCTET, e.value) : tlv(missing ? TAG.NO_SUCH_INSTANCE : TAG.END_OF_MIB);
        out.push(tlv(TAG.SEQ, encodeOid(oid), val));
      };
      if (pdu.tag === TAG.GET) {
        for (const o of oidsIn) {
          const e = store.oids.includes(o) ? (store as unknown as { mib: Record<string, Entry> }).mib[o] : null;
          push(o, e, true);
        }
      } else {
        const rounds = pdu.tag === TAG.GETBULK ? Math.max(1, reps) : 1;
        let cur = oidsIn[0];
        for (let i = 0; i < rounds; i++) {
          const n = store.next(cur);
          if (!n) { push(cur, null); break; }
          push(n.oid, { type: n.type, value: n.value });
          cur = n.oid;
        }
      }
      seen.push(oidsIn[0]);
      store.requests++;
      void ver; void a;
      sock.send(tlv(TAG.SEQ, int(1), octet(community), tlv(TAG.RESPONSE, int(toInt(rid.value)), int(0), int(0), tlv(TAG.SEQ, ...out))), rinfo.port, rinfo.address);
    } catch {
      /* ignoré */
    }
  });
  return new Promise((resolve) => sock.bind(0, "127.0.0.1", () => resolve({ port: sock.address().port, close: () => sock.close(), seen })));
}
