import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { buildMessage, encodeSubject, sendMail, SmtpError, type SmtpEndpoint } from "./smtp";
import { normalizeEmail } from "../signupTypes";
import { TEST_CERT, TEST_KEY } from "./testCert";

interface FakeOpts {
  mode?: "plain" | "implicit" | "starttls";
  advertiseStarttls?: boolean;
  auth?: string; // ex. "PLAIN LOGIN"
  user?: string;
  pass?: string;
  rejectRcpt?: boolean;
  silent?: boolean;
}
interface Fake {
  port: number;
  lines: string[];
  messages: string[];
  close: () => Promise<void>;
}

/** Faux serveur SMTP : enregistre ce que le client envoie. */
async function fake(opts: FakeOpts = {}): Promise<Fake> {
  const lines: string[] = [];
  const messages: string[] = [];
  const mode = opts.mode ?? "plain";
  const handle = (sock: net.Socket, secure: boolean, greet = true) => {
    let buf = "";
    let data: string[] | null = null;
    let authStep: "user" | "pass" | null = null;
    let authUser = "";
    const send = (s: string) => sock.write(s + "\r\n");
    const onLine = (line: string) => {
      if (data) {
        if (line === ".") {
          messages.push(data.join("\r\n"));
          data = null;
          return send("250 2.0.0 queued");
        }
        return void data.push(line);
      }
      if (authStep === "user") {
        authUser = Buffer.from(line, "base64").toString();
        authStep = "pass";
        return send("334 UGFzc3dvcmQ6");
      }
      if (authStep === "pass") {
        authStep = null;
        const ok = authUser === opts.user && Buffer.from(line, "base64").toString() === opts.pass;
        return send(ok ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
      }
      lines.push(line.startsWith("AUTH") ? line.replace(/ [A-Za-z0-9+/=]{6,}$/, " <secret>") : line);
      const u = line.toUpperCase();
      if (u.startsWith("EHLO")) {
        const caps = ["250-fake", ...(opts.advertiseStarttls !== false && mode === "starttls" && !secure ? ["250-STARTTLS"] : []), ...(opts.auth ? [`250-AUTH ${opts.auth}`] : []), "250 8BITMIME"];
        return caps.forEach((c) => send(c));
      }
      if (u === "STARTTLS") {
        send("220 go ahead");
        sock.removeAllListeners("data");
        const t = new tls.TLSSocket(sock, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
        t.on("error", () => {});
        handle(t as unknown as net.Socket, true, false); // après STARTTLS, pas de nouvelle salutation
        return;
      }
      if (u.startsWith("AUTH PLAIN")) {
        const [, user, pass] = Buffer.from(line.split(" ")[2], "base64").toString().split("\0");
        return send(user === opts.user && pass === opts.pass ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
      }
      if (u === "AUTH LOGIN") {
        authStep = "user";
        return send("334 VXNlcm5hbWU6");
      }
      if (u.startsWith("MAIL FROM")) return send("250 ok");
      if (u.startsWith("RCPT TO")) return send(opts.rejectRcpt ? "550 5.1.1 no such user" : "250 ok");
      if (u === "DATA") {
        data = [];
        return send("354 go");
      }
      if (u === "QUIT") {
        send("221 bye");
        return sock.end();
      }
      send("500 what");
    };
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(l);
      }
    });
    sock.on("error", () => {});
    if (greet && !opts.silent) send("220 fake ESMTP");
  };
  const server =
    mode === "implicit"
      ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (s) => handle(s, true))
      : net.createServer((s) => handle(s, false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, lines, messages, close: () => new Promise<void>((r) => { server.close(() => r()); (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); }) };
}

const msg = { to: "Alice@Example.com", subject: "Votre code de vérification", text: "Bonjour é,\n\nCode : 123456\n" };
const ep = (port: number, over: Partial<SmtpEndpoint> = {}): SmtpEndpoint => ({ host: "127.0.0.1", port, security: "none", user: "", password: "", from: "noreply@example.com", ...over });
const trust = { tls: { ca: TEST_CERT }, timeoutMs: 1500 };
async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof SmtpError) return e.kind;
    throw e;
  }
}
const decodeBody = (raw: string) => Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");

test("smtp : envoi simple vers la machine locale, message correct et corps décodable", async () => {
  const f = await fake();
  await sendMail(ep(f.port), msg, { timeoutMs: 1500 });
  assert.ok(f.lines.includes("MAIL FROM:<noreply@example.com>"));
  assert.ok(f.lines.includes("RCPT TO:<alice@example.com>"), "adresse normalisée");
  const raw = f.messages[0];
  assert.match(raw, /^From: IP Architect <noreply@example.com>/m);
  assert.match(raw, /^To: <alice@example.com>/m);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.equal(decodeBody(raw), "Bonjour é,\r\n\r\nCode : 123456\r\n");
  await f.close();
});

test("smtp : AUTH PLAIN puis AUTH LOGIN ; mauvais mot de passe = auth", async () => {
  for (const auth of ["PLAIN LOGIN", "LOGIN"]) {
    const f = await fake({ auth, user: "me@example.com", pass: "s3cret pw" });
    await sendMail(ep(f.port, { user: "me@example.com", password: "s3cret pw" }), msg, { timeoutMs: 1500 });
    assert.equal(f.messages.length, 1, auth);
    await f.close();
  }
  const f = await fake({ auth: "PLAIN", user: "me@example.com", pass: "ok" });
  assert.equal(await kind(sendMail(ep(f.port, { user: "me@example.com", password: "nope" }), msg, { timeoutMs: 1500 })), "auth");
  assert.equal(f.messages.length, 0);
  await f.close();
});

test("smtp : TLS d'emblée et STARTTLS avec certificat de confiance", async () => {
  const a = await fake({ mode: "implicit", auth: "PLAIN", user: "u", pass: "p" });
  await sendMail(ep(a.port, { security: "tls", user: "u", password: "p" }), msg, trust);
  assert.equal(a.messages.length, 1);
  await a.close();
  const b = await fake({ mode: "starttls", auth: "PLAIN", user: "u", pass: "p" });
  await sendMail(ep(b.port, { security: "starttls", user: "u", password: "p" }), msg, trust);
  assert.equal(b.messages.length, 1);
  assert.ok(b.lines.indexOf("STARTTLS") < b.lines.findIndex((l) => l.startsWith("AUTH")), "l'authentification vient APRÈS le chiffrement");
  await b.close();
});

test("smtp : jamais d'identifiants en clair — STARTTLS absent = refus, certificat inconnu = refus", async () => {
  const f = await fake({ mode: "starttls", advertiseStarttls: false, auth: "PLAIN", user: "u", pass: "p" });
  assert.equal(await kind(sendMail(ep(f.port, { security: "starttls", user: "u", password: "p" }), msg, trust)), "tls");
  assert.ok(!f.lines.some((l) => l.startsWith("AUTH")), "aucune tentative d'authentification en clair");
  await f.close();
  const g = await fake({ mode: "implicit" });
  assert.equal(await kind(sendMail(ep(g.port, { security: "tls" }), msg, { timeoutMs: 1500 })), "tls", "certificat auto-signé non approuvé");
  assert.equal(g.messages.length, 0);
  await g.close();
  assert.equal(await kind(sendMail(ep(25, { host: "mail.example.com", security: "none" }), msg)), "tls", "pas de connexion non chiffrée hors machine locale");
});

test("smtp : destinataire refusé, serveur absent, serveur muet", async () => {
  const f = await fake({ rejectRcpt: true });
  assert.equal(await kind(sendMail(ep(f.port), msg, { timeoutMs: 1500 })), "rejected");
  await f.close();
  const dead = await fake();
  const port = dead.port;
  await dead.close();
  assert.equal(await kind(sendMail(ep(port), msg, { timeoutMs: 1500 })), "unreachable");
  const s = await fake({ silent: true });
  assert.equal(await kind(sendMail(ep(s.port), msg, { timeoutMs: 300 })), "timeout");
  await s.close();
});

test("smtp : aucune injection d'en-tête, sujet encodé, adresses strictes", async () => {
  for (const bad of ["a@b.com\r\nBcc: x@y.com", "a@b.com\nRCPT TO:<x@y.com>", "a b@c.com", "<a@b.com>", "a@b", "a@@b.com", ".a@b.com", "a..b@c.com", "é@b.com", "a@b.com,c@d.com"]) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeEmail("  Jean.Dupont+tag@Exemple.FR "), "jean.dupont+tag@exemple.fr");
  assert.equal(await kind(sendMail(ep(1), { ...msg, to: "a@b.com\r\nBcc: x@y.com" })), "rejected");
  assert.equal(encodeSubject("Hello\r\nBcc: evil@x.com"), "Hello Bcc: evil@x.com", "retours à la ligne retirés");
  const enc = encodeSubject("Votre code de vérification IP Architect");
  const decoded = [...enc.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], "base64").toString()).join("");
  assert.equal(decoded, "Votre code de vérification IP Architect");
  assert.ok(enc.split("\r\n ").every((w) => w.length <= 75), "mots encodés <= 75 caractères");
  assert.ok(!buildMessage("a@b.com", { to: "c@d.com", subject: "x", text: "y" }).includes("Bcc"));
});
