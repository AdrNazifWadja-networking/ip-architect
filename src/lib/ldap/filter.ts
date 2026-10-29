/** Filtres LDAP : échappement des valeurs (RFC 4515) et encodage BER d'un filtre en texte (RFC 4511 § 4.5.1). */
import { octet, tlv } from "./ber";

/** À appliquer à TOUTE valeur saisie par une personne avant de l'insérer dans un filtre (injection de filtre). */
export function escapeFilterValue(value: string): string {
  let out = "";
  for (const b of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(b);
    out += b === 0x5c || b === 0x2a || b === 0x28 || b === 0x29 || b === 0x00 ? `\\${b.toString(16).padStart(2, "0")}` : b < 0x80 ? ch : `\\${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** « {username} » remplacé par la valeur échappée. */
export function renderFilter(template: string, username: string): string {
  return template.split("{username}").join(escapeFilterValue(username));
}

function unescapeValue(v: string): Buffer {
  const bytes: number[] = [];
  const raw = Buffer.from(v, "utf8");
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x5c) {
      const hex = raw.subarray(i + 1, i + 3).toString("latin1");
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("filtre : échappement invalide");
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(raw[i]);
  }
  return Buffer.from(bytes);
}

const ATTR = /^[A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*$|^[0-9]+(\.[0-9]+)+$/;

/** Filtre en texte -> octets BER. Lève une erreur si le filtre est invalide (les filtres « extensibles » ne sont pas gérés). */
export function encodeFilter(text: string): Buffer {
  let i = 0;
  const fail = (m: string): never => {
    throw new Error(`filtre : ${m}`);
  };
  const parse = (depth: number): Buffer => {
    if (depth > 10) fail("trop imbriqué");
    if (text[i] !== "(") fail("« ( » attendue");
    i++;
    let out: Buffer;
    const c = text[i];
    if (c === "&" || c === "|") {
      i++;
      const subs: Buffer[] = [];
      while (text[i] === "(") subs.push(parse(depth + 1));
      if (subs.length === 0) fail("opérateur vide");
      out = tlv(c === "&" ? 0xa0 : 0xa1, ...subs);
    } else if (c === "!") {
      i++;
      out = tlv(0xa2, parse(depth + 1));
    } else {
      const end = text.indexOf(")", i);
      // la valeur ne contient jamais « ) » ni « ( » en clair (ils sont échappés) : la première « ) » ferme l'élément
      if (end < 0) return fail("« ) » manquante");
      const item = text.slice(i, end);
      i = end;
      const m = /^([^=<>~()]+)(>=|<=|~=|=)([\s\S]*)$/.exec(item);
      if (!m) return fail("élément invalide");
      const [, attr, op, val] = m;
      if (!ATTR.test(attr)) fail("nom d'attribut invalide");
      if (op === "=") {
        if (val === "*") out = octet(attr, 0x87); // présence
        else if (val.includes("*")) {
          const parts = val.split("*");
          const subs: Buffer[] = [];
          if (parts[0] !== "") subs.push(octet(unescapeValue(parts[0]), 0x80));
          for (const mid of parts.slice(1, -1)) if (mid !== "") subs.push(octet(unescapeValue(mid), 0x81));
          if (parts[parts.length - 1] !== "") subs.push(octet(unescapeValue(parts[parts.length - 1]), 0x82));
          out = tlv(0xa4, octet(attr), tlv(0x30, ...subs));
        } else out = tlv(0xa3, octet(attr), octet(unescapeValue(val)));
      } else {
        out = tlv(op === ">=" ? 0xa5 : op === "<=" ? 0xa6 : 0xa8, octet(attr), octet(unescapeValue(val)));
      }
    }
    if (text[i] !== ")") fail("« ) » attendue");
    i++;
    return out;
  };
  const res = parse(0);
  if (i !== text.length) fail("texte après le filtre");
  return res;
}
