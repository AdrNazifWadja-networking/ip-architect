import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMac, renderCiscoConfig, renderIscConfig, splitLease, type DhcpConfigScope } from "./config";
import { formatLease } from "./lease";

test("normalizeMac accepte les notations courantes et refuse le reste", () => {
  assert.equal(normalizeMac("AA:BB:CC:DD:EE:FF"), "aa:bb:cc:dd:ee:ff");
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-ff"), "aa:bb:cc:dd:ee:ff");
  assert.equal(normalizeMac("aabb.ccdd.eeff"), "aa:bb:cc:dd:ee:ff");
  assert.equal(normalizeMac("aabbccddeeff"), "aa:bb:cc:dd:ee:ff");
  assert.equal(normalizeMac("  00:1A:2B:3C:4D:5E "), "00:1a:2b:3c:4d:5e");
  for (const bad of ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "gg:bb:cc:dd:ee:ff", "aa:bb-cc:dd:ee:ff", "aabb.ccdd.eef", "1.2.3.4"]) {
    assert.equal(normalizeMac(bad), null, bad);
  }
});

test("splitLease / formatLease", () => {
  assert.deepEqual(splitLease(90_061), { d: 1, h: 1, m: 1, s: 1 });
  const units = { d: "{n} d", h: "{n} h", m: "{n} min", s: "{n} s" };
  assert.equal(formatLease(86_400, units), "1 d");
  assert.equal(formatLease(28_800, units), "8 h");
  assert.equal(formatLease(5_400, units), "1 h 30 min");
  assert.equal(formatLease(60, units), "1 min");
  assert.equal(formatLease(0, units), "0 s");
});

const scope: DhcpConfigScope = {
  name: "VLAN 10 DHCP été",
  networkCidr: "10.1.10.0/24",
  rangeStart: "10.1.10.100",
  rangeEnd: "10.1.10.220",
  gateway: "10.1.10.1",
  dns: ["10.1.40.10", "2001:4860:4860::8888", "1.1.1.1"],
  leaseSeconds: 28_800,
  enabled: true,
};
const reservations = [
  { mac: "00:1a:2b:01:0a:01", address: "10.1.10.240", hostname: "print 01" },
  { mac: "00:1a:2b:01:0a:02", address: "10.1.10.241", hostname: "print 01" },
  { mac: "00:1a:2b:01:0a:03", address: "10.1.10.242", hostname: null },
];

test("configuration ISC dhcpd", () => {
  const out = renderIscConfig(scope, reservations);
  assert.match(out, /subnet 10\.1\.10\.0 netmask 255\.255\.255\.0 \{/);
  assert.match(out, /range 10\.1\.10\.100 10\.1\.10\.220;/);
  assert.match(out, /option routers 10\.1\.10\.1;/);
  // l'option DHCPv4 n'accepte pas d'adresse IPv6
  assert.match(out, /option domain-name-servers 10\.1\.40\.10, 1\.1\.1\.1;/);
  assert.doesNotMatch(out, /2001:4860/);
  assert.match(out, /default-lease-time 28800;/);
  assert.match(out, /hardware ethernet 00:1a:2b:01:0a:01;\n\s+fixed-address 10\.1\.10\.240;/);
  // noms d'hôte nettoyés et uniques
  assert.match(out, /host print-01 \{/);
  assert.match(out, /host print-01-2 \{/);
  assert.match(out, /host host-001a2b010a03 \{/);
  assert.ok(out.trimEnd().endsWith("}"));
});

test("configuration Cisco IOS", () => {
  const out = renderCiscoConfig(scope, reservations);
  assert.match(out, /ip dhcp excluded-address 10\.1\.10\.1 10\.1\.10\.99\n/);
  assert.match(out, /ip dhcp excluded-address 10\.1\.10\.221 10\.1\.10\.254\n/);
  assert.match(out, /ip dhcp pool VLAN-10-DHCP-ete\n network 10\.1\.10\.0 255\.255\.255\.0/);
  assert.match(out, / default-router 10\.1\.10\.1\n dns-server 10\.1\.40\.10 1\.1\.1\.1\n lease 0 8 0\n/);
  assert.match(out, / host 10\.1\.10\.240 255\.255\.255\.0\n client-identifier 0100\.1a2b\.010a\.01\n/);
});

test("Cisco : aucune exclusion si la plage couvre tout le réseau, bail arrondi à la minute", () => {
  const full = renderCiscoConfig(
    { ...scope, rangeStart: "10.1.10.1", rangeEnd: "10.1.10.254", gateway: null, dns: [], leaseSeconds: 90 },
    [],
  );
  assert.doesNotMatch(full, /excluded-address/);
  assert.doesNotMatch(full, /default-router|dns-server/);
  assert.match(full, / lease 0 0 2\n/);
});

test("configuration : réseau IPv6 -> chaîne vide, plage désactivée signalée", () => {
  assert.equal(renderIscConfig({ ...scope, networkCidr: "2001:db8::/64" }, []), "");
  assert.equal(renderCiscoConfig({ ...scope, networkCidr: "2001:db8::/64" }, []), "");
  assert.match(renderIscConfig({ ...scope, enabled: false }, []), /# NOTE: this scope is disabled/);
});
