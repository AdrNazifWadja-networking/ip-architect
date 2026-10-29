/**
 * OpenID Connect, flux « code d'autorisation » avec PKCE (S256), « state » et « nonce ».
 *
 * - Chaque tentative est une ligne `sso_flows` à usage unique (10 min). Le navigateur reçoit un cookie de liaison :
 *   le « state » seul ne suffit pas (sinon un attaquant pourrait faire terminer SA connexion dans le navigateur d'une victime).
 * - L'adresse de découverte doit annoncer le même « issuer » que celui configuré, en https (http : machine locale seulement).
 * - Appels réseau sortants : 8 s, pas de redirection, 1 Mo au plus. Les groupes doivent figurer dans le jeton d'identité ou /userinfo.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Db } from "../db/index";
import { getOidcSecret, getSsoConfig } from "../db/ssosettings";
import { ApiError } from "../types";
import { verifyIdToken, JwtError, type Jwk } from "./jwt";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const FLOW_TTL_MS = 10 * 60_000;
const MAX_BODY = 1_000_000;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64u = (b: Buffer) => b.toString("base64url");

const isLocal = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);
function httpsOnly(raw: unknown): string {
  if (typeof raw !== "string") throw new ApiError("ssoProvider", 502);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("ssoProvider", 502);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname.replace(/^\[|\]$/g, "")))) throw new ApiError("ssoProvider", 502);
  return raw;
}

async function getJson(fetcher: FetchLike, url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new ApiError("ssoProvider", 502);
  }
  const text = await res.text().catch(() => "");
  if (text.length > MAX_BODY) throw new ApiError("ssoProvider", 502);
  if (!res.ok) throw new ApiError("ssoProvider", 502);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("ssoProvider", 502);
  }
}

const cache = new Map<string, { at: number; doc: Discovery }>();
export const clearOidcCache = () => cache.clear();

export async function discover(issuer: string, fetcher: FetchLike = fetch, now = Date.now()): Promise<Discovery> {
  const hit = cache.get(issuer);
  if (hit && now - hit.at < 10 * 60_000) return hit.doc;
  const d = await getJson(fetcher, `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!d || d.issuer !== issuer) throw new ApiError("ssoProvider", 502);
  const doc: Discovery = {
    issuer: d.issuer,
    authorization_endpoint: httpsOnly(d.authorization_endpoint),
    token_endpoint: httpsOnly(d.token_endpoint),
    jwks_uri: httpsOnly(d.jwks_uri),
    userinfo_endpoint: d.userinfo_endpoint ? httpsOnly(d.userinfo_endpoint) : undefined,
  };
  cache.set(issuer, { at: now, doc });
  return doc;
}

async function fetchKeys(doc: Discovery, fetcher: FetchLike): Promise<Jwk[]> {
  const j = await getJson(fetcher, doc.jwks_uri);
  return Array.isArray(j?.keys) ? (j.keys as Jwk[]) : [];
}

export interface OidcDeps {
  fetch?: FetchLike;
  now?: Date;
}

/** Adresse de retour : l'adresse publique configurée, sinon celle de la requête. */
export function redirectUri(publicUrl: string, requestOrigin: string): string {
  return `${publicUrl || requestOrigin}/api/auth/oidc/callback`;
}

/** Prépare une tentative : renvoie l'adresse du fournisseur et la valeur du cookie de liaison. */
export async function startOidc(db: Db, requestOrigin: string, deps: OidcDeps = {}): Promise<{ url: string; bind: string }> {
  const { oidc } = getSsoConfig(db);
  if (!oidc.enabled) throw new ApiError("ssoDisabled", 404);
  const doc = await discover(oidc.issuer, deps.fetch);
  const now = deps.now ?? new Date();
  const state = b64u(randomBytes(24));
  const nonce = b64u(randomBytes(24));
  const verifier = b64u(randomBytes(48));
  const bind = b64u(randomBytes(24));
  db.transaction(() => {
    db.prepare("DELETE FROM sso_flows WHERE created_at < ?").run(new Date(now.getTime() - FLOW_TTL_MS).toISOString());
    db.prepare("INSERT INTO sso_flows (state_hash, bind_hash, nonce, verifier, created_at) VALUES (?, ?, ?, ?, ?)").run(sha256(state), sha256(bind), nonce, verifier, now.toISOString());
  })();
  const u = new URL(doc.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: oidc.clientId,
    redirect_uri: redirectUri(oidc.publicUrl, requestOrigin),
    scope: oidc.scopes,
    state,
    nonce,
    code_challenge: b64u(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  return { url: u.toString(), bind };
}

export interface OidcIdentity {
  subject: string;
  usernameCandidate: unknown;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  groups: string[];
}

const asStrings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Termine la tentative : échange le code, vérifie le jeton d'identité, renvoie l'identité (les droits sont décidés ailleurs). */
export async function finishOidc(db: Db, input: { code: unknown; state: unknown; bind: unknown; requestOrigin: string }, deps: OidcDeps = {}): Promise<OidcIdentity> {
  const { oidc } = getSsoConfig(db);
  if (!oidc.enabled) throw new ApiError("ssoDisabled", 404);
  const { code, state, bind } = input;
  if (typeof code !== "string" || typeof state !== "string" || typeof bind !== "string" || !code || code.length > 2000 || state.length > 200 || bind.length > 200) throw new ApiError("ssoState", 400);
  const now = deps.now ?? new Date();
  const fetcher = deps.fetch ?? fetch;

  // la tentative est consommée dès la lecture : un « state » ne sert qu'une fois
  const flow = db.transaction(() => {
    const f = db.prepare("SELECT bind_hash, nonce, verifier, created_at FROM sso_flows WHERE state_hash = ?").get(sha256(state)) as
      | { bind_hash: string; nonce: string; verifier: string; created_at: string }
      | undefined;
    if (f) db.prepare("DELETE FROM sso_flows WHERE state_hash = ?").run(sha256(state));
    return f;
  })();
  if (!flow || flow.bind_hash !== sha256(bind) || now.getTime() - Date.parse(flow.created_at) > FLOW_TTL_MS) throw new ApiError("ssoState", 400);

  const doc = await discover(oidc.issuer, fetcher, now.getTime());
  const secret = getOidcSecret(db);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(oidc.publicUrl, input.requestOrigin),
    client_id: oidc.clientId,
    code_verifier: flow.verifier,
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
  const tok = await getJson(fetcher, doc.token_endpoint, { method: "POST", headers, body: form.toString() });
  if (!tok || typeof tok.id_token !== "string") throw new ApiError("ssoToken", 502);

  let claims: Record<string, unknown>;
  try {
    const opts = { issuer: oidc.issuer, audience: oidc.clientId, nonce: flow.nonce, now: now.getTime() };
    let keys = await fetchKeys(doc, fetcher);
    try {
      claims = verifyIdToken(tok.id_token, keys, opts);
    } catch (e) {
      // clé inconnue : le fournisseur a peut-être fait tourner ses clés, un nouvel essai avec un jeu à jour
      if (!(e instanceof JwtError) || !/clé/.test(e.message)) throw e;
      keys = await fetchKeys(doc, fetcher);
      claims = verifyIdToken(tok.id_token, keys, opts);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("ssoToken", 401);
  }

  // revendications absentes du jeton d'identité : on les demande à /userinfo (le sujet doit être le même)
  const needs = [oidc.usernameClaim, oidc.groupsClaim].filter(Boolean).filter((c) => claims[c] === undefined);
  if ((needs.length > 0 || claims.email === undefined) && doc.userinfo_endpoint && typeof tok.access_token === "string") {
    try {
      const info = await getJson(fetcher, doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } });
      if (info && info.sub === claims.sub) claims = { ...info, ...claims };
    } catch {
      /* facultatif */
    }
  }

  const email = typeof claims.email === "string" && claims.email.length <= 254 ? claims.email.toLowerCase() : null;
  return {
    subject: claims.sub as string,
    usernameCandidate: claims[oidc.usernameClaim] ?? claims.preferred_username ?? email,
    displayName: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 80) : null,
    email,
    emailVerified: claims.email_verified === true,
    groups: oidc.groupsClaim ? asStrings(claims[oidc.groupsClaim]).slice(0, 500) : [],
  };
}

