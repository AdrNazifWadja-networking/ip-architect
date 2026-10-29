/**
 * BER minimal pour LDAP v3 (RFC 4511) : longueurs définies, assez pour « bind », « search », « unbind » et « StartTLS ».
 * Aucune dépendance : l'application n'embarque pas de bibliothèque LDAP.
 */

export const T = {
  INTEGER: 0x02,
  OCTET: 0x04,
  ENUM: 0x0a,
  BOOL: 0x01,
  SEQ: 0x30,
  SET: 0x31,
  BIND_REQ: 0x60,
  BIND_RES: 0x61,
  UNBIND_REQ: 0x42,
  SEARCH_REQ: 0x63,
  SEARCH_ENTRY: 0x64,
  SEARCH_DONE: 0x65,
  SEARCH_REF: 0x73,
  EXT_REQ: 0x77,
  EXT_RES: 0x78,
} as const;

export function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

export const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
};

export function int(n: number, tag: number = T.INTEGER): Buffer {
  // entier signé, forme la plus courte
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = v >> 8;
  } while (!((v === 0 && (bytes[0] & 0x80) === 0) || (v === -1 && (bytes[0] & 0x80) !== 0)));
  return tlv(tag, Buffer.from(bytes));
}

export const octet = (v: string | Buffer, tag: number = T.OCTET): Buffer => tlv(tag, typeof v === "string" ? Buffer.from(v, "utf8") : v);
export const bool = (v: boolean): Buffer => tlv(T.BOOL, Buffer.from([v ? 0xff : 0x00]));

export interface Tlv {
  tag: number;
  /** Contenu (sans l'en-tête). */
  value: Buffer;
  /** Position du premier octet après cet élément. */
  next: number;
}

/** Lit un élément à `offset` ; null si le tampon est incomplet ; lève une erreur si l'encodage est invalide ou trop gros. */
export function readTlv(buf: Buffer, offset = 0, maxLen = 4 * 1024 * 1024): Tlv | null {
  if (buf.length - offset < 2) return null;
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new Error("ber: étiquette longue non gérée");
  let len = buf[offset + 1];
  let pos = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("ber: longueur non gérée");
    if (buf.length - pos < n) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + i];
    pos += n;
  }
  if (len > maxLen) throw new Error("ber: élément trop gros");
  if (buf.length - pos < len) return null;
  return { tag, value: buf.subarray(pos, pos + len), next: pos + len };
}

/** Tous les éléments contenus dans `value` (qui doit être complet). */
export function children(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < value.length) {
    const t = readTlv(value, off);
    if (!t) throw new Error("ber: contenu tronqué");
    out.push(t);
    off = t.next;
  }
  return out;
}

export function toInt(v: Buffer): number {
  if (v.length === 0 || v.length > 6) throw new Error("ber: entier invalide");
  let n = v[0] & 0x80 ? -1 : 0;
  for (const b of v) n = n * 256 + b;
  return n;
}
