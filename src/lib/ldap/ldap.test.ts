import { test } from "node:test";
import assert from "node:assert/strict";
import { T, int, octet, readTlv, tlv, toInt, lengthBytes } from "./ber";
import { DIR, fakeLdap } from "./fakeServer";
import { encodeFilter, escapeFilterValue, renderFilter } from "./filter";
import { connectLdap, parseLdapUrl, LdapError } from "./client";

test("BER : longueurs et entiers (vecteurs connus)", () => {
  assert.deepEqual([...lengthBytes(5)], [5]);
  assert.deepEqual([...lengthBytes(127)], [127]);
  assert.deepEqual([...lengthBytes(128)], [0x81, 0x80]);
  assert.deepEqual([...lengthBytes(300)], [0x82, 0x01, 0x2c]);
  assert.deepEqual([...int(0)], [2, 1, 0]);
  assert.deepEqual([...int(127)], [2, 1, 0x7f]);
  assert.deepEqual([...int(128)], [2, 2, 0, 0x80]);
  assert.deepEqual([...int(256)], [2, 2, 1, 0]);
  assert.deepEqual([...int(-1)], [2, 1, 0xff]);
  assert.equal(toInt(Buffer.from([0, 0x80])), 128);
  assert.equal(toInt(Buffer.from([0xff])), -1);
  // message « bind » connu : 30 0c 02 01 01 60 07 02 01 03 04 00 80 00
  const bind = tlv(T.SEQ, int(1), tlv(T.BIND_REQ, int(3), octet(""), octet("", 0x80)));
  assert.equal(bind.toString("hex"), "300c020101600702010304008000");
});

test("BER : lecture incomplète = null, élément trop gros ou longueur folle = erreur", () => {
  const msg = tlv(T.SEQ, int(1), octet("x".repeat(200)));
  assert.equal(readTlv(msg.subarray(0, 10)), null);
  assert.equal(readTlv(msg)?.next, msg.length);
  assert.throws(() => readTlv(Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 1])));
  assert.throws(() => readTlv(Buffer.from([0x30, 0x85, 1, 1, 1, 1, 1, 1])));
});

test("filtres : échappement (injection) et encodage BER", () => {
  assert.equal(escapeFilterValue("a*b(c)\\"), "a\\2ab\\28c\\29\\5c");
  assert.equal(escapeFilterValue("é"), "\\c3\\a9");
  assert.equal(renderFilter("(uid={username})", "*)(uid=*"), "(uid=\\2a\\29\\28uid=\\2a)");
  // (uid=bob) -> a3 0a 04 03 uid 04 03 bob
  assert.equal(encodeFilter("(uid=bob)").toString("hex"), "a30a04037569640403626f62");
  assert.equal(encodeFilter("(uid=*)").toString("hex"), "870375" + "6964");
  const and = encodeFilter("(&(a=1)(|(b=2)(!(c=3))))");
  assert.equal(and[0], 0xa0);
  assert.ok(encodeFilter("(cn=a*b*c)")[0] === 0xa4);
  assert.ok(encodeFilter("(age>=5)")[0] === 0xa5 && encodeFilter("(age<=5)")[0] === 0xa6);
  for (const bad of ["", "uid=bob", "(uid=bob", "(uid=bob))", "(=x)", "(&)x", "(uid=\\zz)"]) assert.throws(() => encodeFilter(bad), bad);
});

test("adresses LDAP", () => {
  assert.deepEqual(parseLdapUrl("ldaps://dc.example.com"), { secure: true, host: "dc.example.com", port: 636 });
  assert.deepEqual(parseLdapUrl("ldap://10.0.0.5:3389"), { secure: false, host: "10.0.0.5", port: 3389 });
  assert.deepEqual(parseLdapUrl("ldap://[::1]"), { secure: false, host: "::1", port: 389 });
  for (const bad of ["http://x", "ldap://", "ldap://a b", "ldap://x:99999", "ldap://x/ou=a", "ldaps://x:0"]) assert.equal(parseLdapUrl(bad), null, bad);
});

test("client LDAP sur une vraie socket : bind, recherche, refus, mot de passe vide, renvois ignorés", async () => {
  const srv = await fakeLdap(DIR);
  try {
    const c = await connectLdap({ url: srv.url, startTls: false });
    assert.equal(await c.bind("cn=svc,dc=ex", "svcpw"), true);
    const r = await c.search("dc=ex", "(uid=alice)", ["uid", "cn", "mail", "memberOf"]);
    assert.equal(r.length, 1);
    assert.equal(r[0].dn, "uid=alice,ou=p,dc=ex");
    assert.deepEqual(r[0].attrs.memberof, ["cn=admins,ou=g,dc=ex", "cn=staff,ou=g,dc=ex"]);
    assert.equal((await c.search("dc=ex", "(uid=nobody)", ["uid"])).length, 0);
    assert.equal(await c.bind("uid=alice,ou=p,dc=ex", "faux"), false);
    await assert.rejects(c.bind("uid=alice,ou=p,dc=ex", ""), (e: unknown) => e instanceof LdapError && e.kind === "protocol");
    await c.close();
  } finally {
    srv.close();
  }
});

test("client LDAP : injection de filtre neutralisée, connexion refusée et coupure = erreur", async () => {
  const srv = await fakeLdap(DIR);
  try {
    const c = await connectLdap({ url: srv.url, startTls: false });
    const r = await c.search("dc=ex", renderFilter("(uid={username})", "*"), ["uid"]);
    assert.equal(r.length, 0); // « * » littéral, pas un joker
    assert.ok(srv.seen.filters.at(-1)!.endsWith("*"));
    await c.close();
  } finally {
    srv.close();
  }
  await assert.rejects(connectLdap({ url: "ldap://127.0.0.1:1", startTls: false }), (e: unknown) => e instanceof LdapError);
  const drop = await fakeLdap(DIR, { dropAfterBind: true });
  try {
    const c = await connectLdap({ url: drop.url, startTls: false });
    await c.bind("cn=svc,dc=ex", "svcpw").catch(() => {});
    await assert.rejects(c.search("dc=ex", "(uid=a)", ["uid"]), LdapError);
  } finally {
    drop.close();
  }
});
