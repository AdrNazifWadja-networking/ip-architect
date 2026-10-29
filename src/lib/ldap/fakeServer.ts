/** Faux serveur LDAP pour les tests : bind simple et recherche à égalité, sur une vraie socket (aucun usage en production). */
import net from "node:net";
import { T, children, int, octet, readTlv, tlv, toInt } from "./ber";

export interface Entry { dn: string; password: string; attrs: Record<string, string[]> }
export function fakeLdap(entries: Entry[], opts: { dropAfterBind?: boolean; hang?: boolean } = {}) {
  const seen: { filters: string[]; binds: string[] } = { filters: [], binds: [] };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const send = (id: number, op: Buffer) => sock.write(tlv(T.SEQ, int(id), op));
    const res = (tag: number, code: number, diag = "") => tlv(tag, int(code, T.ENUM), octet(""), octet(diag));
    sock.on("data", (d: Buffer) => {
      if (opts.hang) return;
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const m = readTlv(buf);
        if (!m) return;
        buf = buf.subarray(m.next);
        const [idT, op] = children(m.value);
        const id = toInt(idT.value);
        if (op.tag === T.BIND_REQ) {
          const [, dn, pw] = children(op.value);
          const dnS = dn.value.toString(), pwS = pw.value.toString();
          seen.binds.push(dnS);
          const ok = entries.some((e) => e.dn === dnS && e.password === pwS) || (dnS === "" && pwS === "");
          send(id, res(T.BIND_RES, ok ? 0 : 49, ok ? "" : "bad"));
          if (opts.dropAfterBind) sock.destroy();
        } else if (op.tag === T.SEARCH_REQ) {
          const p = children(op.value);
          const filt = p[6];
          seen.filters.push(filt.tag.toString(16) + ":" + filt.value.toString("latin1"));
          let attr = "", val = "";
          if (filt.tag === 0xa3) {
            const [a, v] = children(filt.value);
            attr = a.value.toString().toLowerCase();
            val = v.value.toString();
          }
          const hits = entries.filter((e) => filt.tag === 0xa3 && (e.attrs[attr] ?? []).some((x) => x.toLowerCase() === val.toLowerCase()));
          for (const e of hits) {
            const attrs = Object.entries(e.attrs).map(([k, vs]) => tlv(T.SEQ, octet(k), tlv(T.SET, ...vs.map((v) => octet(v)))));
            send(id, tlv(T.SEARCH_ENTRY, octet(e.dn), tlv(T.SEQ, ...attrs)));
          }
          send(id, tlv(0x73, octet("ldap://elsewhere/"))); // renvoi : ignoré
          send(id, res(T.SEARCH_DONE, 0));
        } else if (op.tag === T.UNBIND_REQ) sock.end();
      }
    });
    sock.on("error", () => {});
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `ldap://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen, close: () => server.close() })),
  );
}

export const DIR: Entry[] = [
  { dn: "cn=svc,dc=ex", password: "svcpw", attrs: { uid: ["svc"] } },
  { dn: "uid=alice,ou=p,dc=ex", password: "alicepw", attrs: { uid: ["alice"], cn: ["Alice A"], mail: ["alice@ex.fr"], memberof: ["cn=admins,ou=g,dc=ex", "cn=staff,ou=g,dc=ex"] } },
  { dn: "uid=bob,ou=p,dc=ex", password: "bobpw", attrs: { uid: ["bob"], cn: ["Bob B"] } },
  { dn: "uid=dup1,ou=p,dc=ex", password: "x", attrs: { uid: ["dup"] } },
  { dn: "uid=dup2,ou=p,dc=ex", password: "y", attrs: { uid: ["dup"] } },
];

