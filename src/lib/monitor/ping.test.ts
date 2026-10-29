import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { MAX_PROBE_ADDRESSES, PingUnavailableError, parsePing, ping, pingCommand, pingMany } from "./ping";

test("commande : options propres à chaque système, adresse en dernier argument, jamais de shell", () => {
  assert.deepEqual(pingCommand("linux", 4, "10.0.0.1"), { cmd: "ping", args: ["-c", "1", "-W", "1", "10.0.0.1"] });
  assert.deepEqual(pingCommand("linux", 6, "2001:db8::1"), { cmd: "ping", args: ["-c", "1", "-W", "1", "-6", "2001:db8::1"] });
  assert.deepEqual(pingCommand("win32", 4, "10.0.0.1"), { cmd: "ping", args: ["-n", "1", "-w", "1000", "-4", "10.0.0.1"] });
  assert.deepEqual(pingCommand("win32", 6, "::1"), { cmd: "ping", args: ["-n", "1", "-w", "1000", "-6", "::1"] });
  assert.deepEqual(pingCommand("darwin", 4, "10.0.0.1"), { cmd: "ping", args: ["-c", "1", "-W", "1000", "10.0.0.1"] });
  assert.deepEqual(pingCommand("darwin", 6, "::1"), { cmd: "ping6", args: ["-c", "1", "::1"] });
});

test("sortie Linux/macOS : code 0 = répond, temps lu (point ou virgule)", () => {
  const ok = "64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms";
  assert.deepEqual(parsePing("linux", 4, 0, ok), { alive: true, ms: 0.045 });
  assert.deepEqual(parsePing("darwin", 4, 0, "64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=1,5 ms"), { alive: true, ms: 1.5 });
  assert.deepEqual(parsePing("linux", 4, 1, "1 packets transmitted, 0 received, 100% packet loss"), { alive: false, ms: null });
});

test("sortie Windows : exige TTL= en IPv4 (le code 0 ne suffit pas : « hôte inaccessible » renvoie 0)", () => {
  const en = "Reply from 192.168.1.1: bytes=32 time=2ms TTL=64";
  const fr = "Réponse de 192.168.1.1 : octets=32 temps<1ms TTL=64";
  const unreachable = "Reply from 192.168.1.50: Destination host unreachable.";
  const frUnreachable = "Réponse de 192.168.1.50 : Impossible de joindre l'hôte de destination.";
  assert.deepEqual(parsePing("win32", 4, 0, en), { alive: true, ms: 2 });
  assert.deepEqual(parsePing("win32", 4, 0, fr), { alive: true, ms: 1 });
  assert.equal(parsePing("win32", 4, 0, unreachable).alive, false);
  assert.equal(parsePing("win32", 4, 0, frUnreachable).alive, false);
  assert.equal(parsePing("win32", 4, 1, "Request timed out.").alive, false);
  // IPv6 : pas de TTL dans la sortie
  assert.equal(parsePing("win32", 6, 0, "Reply from ::1: time<1ms").alive, true);
  assert.equal(parsePing("win32", 6, 0, "Reply from fe80::1: Destination host unreachable.").alive, false);
});

test("adresse invalide : rien n'est exécuté (aucune chaîne libre n'atteint la commande)", async () => {
  let calls = 0;
  const exec = async () => {
    calls++;
    return { code: 0, stdout: "" };
  };
  for (const bad of ["", "abc", "10.0.0.1; rm -rf /", "$(id)", "10.0.0.256", "-c 100 10.0.0.1", "10.0.0.1 -f"]) {
    assert.deepEqual(await ping(bad, "linux", exec), { alive: false, ms: null });
  }
  assert.equal(calls, 0);
});

test("pingMany : ordre conservé, parallélisme limité à 8, erreur « ping absent » propagée", async () => {
  let running = 0;
  let peak = 0;
  const exec = async (_c: string, args: string[]) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    const addr = args[args.length - 1];
    return { code: addr.endsWith(".7") ? 1 : 0, stdout: "time=1.0 ms" };
  };
  const addrs = Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}`);
  const res = await pingMany(addrs, "linux", exec);
  assert.equal(res.length, 30);
  assert.equal(res[6].alive, false); // 10.0.0.7
  assert.equal(res[0].alive, true);
  assert.ok(peak <= 8 && peak > 1, `pic de parallélisme : ${peak}`);
  assert.equal(MAX_PROBE_ADDRESSES, 64);
  await assert.rejects(
    pingMany(["10.0.0.1"], "linux", async () => {
      throw new PingUnavailableError("ping");
    }),
    PingUnavailableError,
  );
  assert.deepEqual(await pingMany([], "linux", exec), []);
});

test("réel : ping de 127.0.0.1 si la commande existe sur cette machine", async (t) => {
  try {
    execFileSync("ping", ["-V"], { stdio: "ignore" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return t.skip("commande ping absente");
  }
  const r = await ping("127.0.0.1");
  assert.equal(r.alive, true);
  assert.ok(r.ms === null || r.ms >= 0);
  // une adresse de documentation (RFC 5737) ne répond jamais
  assert.equal((await ping("192.0.2.1")).alive, false);
});

test("exécution réelle (faux « ping » dans le PATH) : succès, échec, délai dépassé, commande absente", async (t) => {
  if (process.platform === "win32") return t.skip("script shell : test réservé à Linux/macOS");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fakeping-"));
  const oldPath = process.env.PATH;
  try {
    // dernier argument = adresse : .1 répond, .2 échoue (code 1), .3 dépasse le délai
    writeFileSync(
      join(dir, "ping"),
      `#!/bin/sh
for a; do last="$a"; done
case "$last" in
  *.1) echo "64 bytes from $last: icmp_seq=1 ttl=64 time=0.7 ms"; exit 0;;
  *.2) echo "100% packet loss"; exit 1;;
  *.3) sleep 10; exit 0;;
esac
exit 1
`,
    );
    chmodSync(join(dir, "ping"), 0o755);
    process.env.PATH = `${dir}:${oldPath}`;
    assert.deepEqual(await ping("10.0.0.1", "linux"), { alive: true, ms: 0.7 });
    assert.deepEqual(await ping("10.0.0.2", "linux"), { alive: false, ms: null });
    const t0 = Date.now();
    assert.equal((await ping("10.0.0.3", "linux")).alive, false);
    assert.ok(Date.now() - t0 < 6000, "le délai doit être coupé (≈3 s)");
    assert.deepEqual((await pingMany(["10.0.0.1", "10.0.0.2"], "linux")).map((r) => r.alive), [true, false]);
    // commande absente
    process.env.PATH = dir + "-inexistant";
    await assert.rejects(ping("10.0.0.1", "linux"), PingUnavailableError);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
