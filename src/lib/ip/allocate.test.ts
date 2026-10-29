import { test } from "node:test";
import assert from "node:assert/strict";
import { addressAt, isAssignable, nextFreeAddress, normalizeIp, offsetInCidr } from "./allocate";

test("normalizeIp met les adresses en forme canonique", () => {
  assert.equal(normalizeIp("192.168.1.5"), "192.168.1.5");
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:0:0001"), "2001:db8::1");
  assert.equal(normalizeIp("999.1.1.1"), null);
  assert.equal(normalizeIp("n'importe quoi"), null);
});

test("isAssignable : ni adresse réseau, ni broadcast, ni hors réseau (IPv4)", () => {
  assert.ok(isAssignable("192.168.1.0/24", "192.168.1.1"));
  assert.ok(isAssignable("192.168.1.0/24", "192.168.1.254"));
  assert.ok(!isAssignable("192.168.1.0/24", "192.168.1.0"));
  assert.ok(!isAssignable("192.168.1.0/24", "192.168.1.255"));
  assert.ok(!isAssignable("192.168.1.0/24", "192.168.2.1"));
  assert.ok(!isAssignable("192.168.1.0/24", "2001:db8::1")); // mauvaise version
});

test("isAssignable : /31 (point à point) et /32 (hôte unique)", () => {
  assert.ok(isAssignable("10.0.0.0/31", "10.0.0.0"));
  assert.ok(isAssignable("10.0.0.0/31", "10.0.0.1"));
  assert.ok(isAssignable("10.0.0.5/32", "10.0.0.5"));
  assert.ok(!isAssignable("10.0.0.5/32", "10.0.0.6"));
});

test("nextFreeAddress : première adresse libre, en sautant les adresses prises", () => {
  assert.equal(nextFreeAddress("192.168.1.0/24", new Set()), "192.168.1.1");
  assert.equal(nextFreeAddress("192.168.1.0/24", new Set(["192.168.1.1", "192.168.1.2"])), "192.168.1.3");
  // un trou au milieu est comblé en premier
  assert.equal(nextFreeAddress("192.168.1.0/24", new Set(["192.168.1.1", "192.168.1.3"])), "192.168.1.2");
});

test("nextFreeAddress : réseau plein -> null", () => {
  assert.equal(nextFreeAddress("10.0.0.0/30", new Set(["10.0.0.1"])), "10.0.0.2");
  assert.equal(nextFreeAddress("10.0.0.0/30", new Set(["10.0.0.1", "10.0.0.2"])), null);
  assert.equal(nextFreeAddress("10.0.0.0/31", new Set(["10.0.0.0", "10.0.0.1"])), null);
  assert.equal(nextFreeAddress("10.0.0.5/32", new Set(["10.0.0.5"])), null);
});

test("nextFreeAddress : IPv6, instantané même sur un /64", () => {
  const taken = new Set(["2001:db8:1:10::", "2001:db8:1:10::1"]);
  assert.equal(nextFreeAddress("2001:db8:1:10::/64", taken), "2001:db8:1:10::2");
  assert.equal(nextFreeAddress("garbage", new Set()), null);
});

test("offsetInCidr / addressAt sont réciproques", () => {
  assert.equal(offsetInCidr("192.168.1.0/24", "192.168.1.0"), 0);
  assert.equal(offsetInCidr("192.168.1.0/24", "192.168.1.77"), 77);
  assert.equal(offsetInCidr("192.168.1.0/24", "192.168.2.1"), null);
  assert.equal(offsetInCidr("192.168.1.0/24", "2001:db8::1"), null);
  assert.equal(addressAt("192.168.1.0/24", 77), "192.168.1.77");
  assert.equal(addressAt("192.168.1.0/24", 256), null);
  assert.equal(addressAt("2001:db8:1:10::/64", 10), "2001:db8:1:10::a");
  assert.equal(offsetInCidr("2001:db8:1:10::/64", "2001:db8:1:10::a"), 10);
});
