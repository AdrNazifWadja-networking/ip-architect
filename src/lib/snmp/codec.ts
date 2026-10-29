/**
 * Codec SNMP v2c (RFC 3416) sur le BER minimal de src/lib/ldap/ber.ts : OID, requêtes GET / GETNEXT / GETBULK, réponses.
 * Aucune dépendance. Seule la lecture est implémentée : ce module ne sait pas envoyer de SET.
 */
import { children, int, octet, readTlv, tlv, toInt } from "../ldap/ber";

export const TAG = {
  INTEGER: 0x02, OCTET: 0x04, NULL: 0x05, OID: 0x06, SEQ: 0x30,
  IPADDRESS: 0x40, COUNTER32: 0x41, GAUGE32: 0x42, TIMETICKS: 0x43, OPAQUE: 0x44, COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80, NO_SUCH_INSTANCE: 0x81, END_OF_MIB: 0x82,
  GET: 0xa0, GETNEXT: 0xa1, RESPONSE: 0xa2, GETBULK: 0xa5,
} as const;

export type ValueType = "int" | "uint" | "str" | "oid" | "ip" | "null" | "missing" | "end";

export interface VarBind {
  oid: string;
  type: ValueType;
  /** Contenu brut (sans l'en-tête BER). */
  value: Buffer;
}

export class SnmpError extends Error {
  constructor(
    public readonly kind: "timeout" | "protocol" | "tooBig" | "refused" | "blocked",
    message: string,
  ) {
    super(message);
  }
}

/* ----------------------------------- OID ----------------------------------- */

export function encodeOid(oid: string): Buffer {
  const p = oid.split(".").map(Number);
  if (p.length < 2 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || p[0] > 2 || (p[0] < 2 && p[1] > 39)) throw new SnmpError("protocol", `OID invalide : ${oid}`);
  const subs = [p[0] * 40 + p[1], ...p.slice(2)];
  const out: number[] = [];
  for (const s of subs) {
    const chunk = [s % 128];
    for (let v = Math.floor(s / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80);
    out.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(out));
}

export function decodeOid(b: Buffer): string {
  if (b.length === 0) throw new SnmpError("protocol", "OID vide");
  const subs: number[] = [];
  let cur = 0;
  for (const byte of b) {
    cur = cur * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      subs.push(cur);
      cur = 0;
    }
  }
  const first = subs[0] < 40 ? 0 : subs[0] < 80 ? 1 : 2;
  return [first, subs[0] - first * 40, ...subs.slice(1)].join(".");
}

const parts = (oid: string): number[] => oid.split(".").map(Number);

/** -1, 0, 1 : ordre numérique des sous-identifiants (l'ordre du GETNEXT). */
export function oidCompare(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** `oid` est strictement sous `prefix` (le préfixe lui-même n'en fait pas partie). */
export const oidUnder = (oid: string, prefix: string): boolean => oid.startsWith(prefix + ".");

/** Sous-identifiants de `oid` après `prefix` (« .3.5 » pour 1.2.3.5 sous 1.2), ou null. */
export function oidSuffix(oid: string, prefix: string): number[] | null {
  return oidUnder(oid, prefix) ? parts(oid.slice(prefix.length + 1)) : null;
}

/* --------------------------------- Messages --------------------------------- */

export interface Request {
  community: string;
  requestId: number;
  kind: "get" | "getnext" | "getbulk";
  oids: string[];
  /** GETBULK seulement. */
  maxRepetitions?: number;
}

export function encodeRequest(r: Request): Buffer {
  const pduTag = r.kind === "get" ? TAG.GET : r.kind === "getnext" ? TAG.GETNEXT : TAG.GETBULK;
  const a = r.kind === "getbulk" ? 0 : 0; // non-repeaters / error-status
  const b = r.kind === "getbulk" ? (r.maxRepetitions ?? 20) : 0; // max-repetitions / error-index
  const binds = r.oids.map((o) => tlv(TAG.SEQ, encodeOid(o), tlv(TAG.NULL)));
  return tlv(TAG.SEQ, int(1), octet(r.community), tlv(pduTag, int(r.requestId), int(a), int(b), tlv(TAG.SEQ, ...binds)));
}

const TYPE_OF: Record<number, ValueType> = {
  [TAG.INTEGER]: "int", [TAG.OCTET]: "str", [TAG.OID]: "oid", [TAG.NULL]: "null", [TAG.IPADDRESS]: "ip",
  [TAG.COUNTER32]: "uint", [TAG.GAUGE32]: "uint", [TAG.TIMETICKS]: "uint", [TAG.COUNTER64]: "uint", [TAG.OPAQUE]: "str",
  [TAG.NO_SUCH_OBJECT]: "missing", [TAG.NO_SUCH_INSTANCE]: "missing", [TAG.END_OF_MIB]: "end",
};

export interface Response {
  community: string;
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: VarBind[];
}

export function decodeResponse(buf: Buffer): Response {
  try {
    const msg = readTlv(buf);
    if (!msg || msg.tag !== TAG.SEQ) throw new Error("message");
    const [ver, comm, pdu] = children(msg.value);
    if (!ver || !comm || !pdu || toInt(ver.value) !== 1 || pdu.tag !== TAG.RESPONSE) throw new Error("en-tête");
    const [rid, es, ei, binds] = children(pdu.value);
    const varbinds: VarBind[] = children(binds.value).map((b) => {
      const [o, v] = children(b.value);
      if (o.tag !== TAG.OID || !v) throw new Error("variable");
      const type = TYPE_OF[v.tag];
      if (!type) throw new Error(`type ${v.tag}`);
      return { oid: decodeOid(o.value), type, value: v.value };
    });
    return { community: comm.value.toString("latin1"), requestId: toInt(rid.value), errorStatus: toInt(es.value), errorIndex: toInt(ei.value), varbinds };
  } catch (e) {
    if (e instanceof SnmpError) throw e;
    throw new SnmpError("protocol", `réponse SNMP invalide : ${(e as Error).message}`);
  }
}

/* ------------------------- Lecture des valeurs ------------------------- */

const TEXT_OK = /^[\x20-\x7e -￿\t\r\n]*$/;
/** Texte d'une valeur ; les octets non imprimables (une MAC, par exemple) donnent null. */
export function vbText(v: VarBind | undefined): string | null {
  if (!v || v.type !== "str") return null;
  const s = v.value.toString("utf8").replace(/\0+$/, "");
  return TEXT_OK.test(s) ? s : null;
}

export function vbNumber(v: VarBind | undefined): number | null {
  if (!v || (v.type !== "int" && v.type !== "uint") || v.value.length === 0 || v.value.length > 9) return null;
  let n = v.type === "int" && v.value[0] & 0x80 ? -1n : 0n;
  for (const b of v.value) n = n * 256n + BigInt(b);
  return Number(n);
}

export function vbOid(v: VarBind | undefined): string | null {
  return v && v.type === "oid" ? decodeOid(v.value) : null;
}

/** « aa:bb:cc:dd:ee:ff » depuis 6 octets ; null sinon. */
export function macOf(b: Buffer): string | null {
  return b.length === 6 ? [...b].map((x) => x.toString(16).padStart(2, "0")).join(":") : null;
}

export function vbIp(v: VarBind | undefined): string | null {
  if (!v || (v.type !== "ip" && v.type !== "str") || v.value.length !== 4) return null;
  return [...v.value].join(".");
}
