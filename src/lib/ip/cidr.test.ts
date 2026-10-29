import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcSubnet,
  cidrContains,
  cidrOverlap,
  formatIPv6,
  ipInCidr,
  normalizeCidr,
  parseIPv4,
  parseIPv6,
  splitCidr,
} from "./cidr";

test("parseIPv4 valide / invalide", () => {
  assert.equal(parseIPv4("192.168.1.1"), 3232235777n);
  assert.equal(parseIPv4("256.1.1.1"), null);
  assert.equal(parseIPv4("1.2.3"), null);
  assert.equal(parseIPv4("01.2.3.4"), null);
});

test("calcSubnet IPv4 /24", () => {
  const s = calcSubnet("192.168.1.77/24")!;
  assert.equal(s.cidr, "192.168.1.0/24");
  assert.equal(s.network, "192.168.1.0");
  assert.equal(s.broadcast, "192.168.1.255");
  assert.equal(s.netmask, "255.255.255.0");
  assert.equal(s.wildcard, "0.0.0.255");
  assert.equal(s.firstHost, "192.168.1.1");
  assert.equal(s.lastHost, "192.168.1.254");
  assert.equal(s.total, 256n);
  assert.equal(s.usable, 254n);
});

test("calcSubnet cas limites /31 /32 /0", () => {
  assert.equal(calcSubnet("10.0.0.0/31")!.usable, 2n);
  assert.equal(calcSubnet("10.0.0.5/32")!.usable, 1n);
  assert.equal(calcSubnet("0.0.0.0/0")!.total, 1n << 32n);
});

test("calcSubnet /22 et masque", () => {
  const s = calcSubnet("10.1.5.9/22")!;
  assert.equal(s.network, "10.1.4.0");
  assert.equal(s.broadcast, "10.1.7.255");
  assert.equal(s.netmask, "255.255.252.0");
  assert.equal(s.usable, 1022n);
});

test("IPv6 parse + format", () => {
  assert.equal(formatIPv6(parseIPv6("2001:db8:0:0:0:0:0:1")!), "2001:db8::1");
  assert.equal(formatIPv6(parseIPv6("::")!), "::");
  assert.equal(formatIPv6(parseIPv6("::1")!), "::1");
  assert.equal(parseIPv6("1::2::3"), null);
  assert.equal(parseIPv6("2001:db8::g"), null);
  assert.equal(formatIPv6(parseIPv6("::ffff:192.0.2.1")!), "::ffff:c000:201");
});

test("calcSubnet IPv6 /64", () => {
  const s = calcSubnet("2001:db8:abcd:12::5/64")!;
  assert.equal(s.cidr, "2001:db8:abcd:12::/64");
  assert.equal(s.total, 1n << 64n);
  assert.equal(s.broadcast, null);
});

test("normalizeCidr", () => {
  assert.equal(normalizeCidr("10.0.0.77/8"), "10.0.0.0/8");
  assert.equal(normalizeCidr("10.0.0.0/33"), null);
  assert.equal(normalizeCidr("foo"), null);
});

test("contains / overlap / ipInCidr", () => {
  assert.ok(cidrContains("10.0.0.0/8", "10.20.0.0/16"));
  assert.ok(!cidrContains("10.20.0.0/16", "10.0.0.0/8"));
  assert.ok(cidrOverlap("192.168.0.0/24", "192.168.0.128/25"));
  assert.ok(!cidrOverlap("192.168.0.0/24", "192.168.1.0/24"));
  assert.ok(!cidrOverlap("10.0.0.0/8", "2001:db8::/32"));
  assert.ok(ipInCidr("172.16.5.4", "172.16.0.0/12"));
  assert.ok(!ipInCidr("172.32.0.1", "172.16.0.0/12"));
});

test("splitCidr", () => {
  assert.deepEqual(splitCidr("192.168.0.0/24", 26), [
    "192.168.0.0/26",
    "192.168.0.64/26",
    "192.168.0.128/26",
    "192.168.0.192/26",
  ]);
  assert.equal(splitCidr("10.0.0.0/24", 16), null);
  assert.equal(splitCidr("2001:db8::/32", 64, 10)!.length, 10);
});
