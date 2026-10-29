/**
 * Vérification d'un jeton d'identité OpenID Connect (JWT signé) avec node:crypto, sans dépendance.
 * Algorithmes acceptés : RS256 et ES256 UNIQUEMENT (jamais « none » ni HS* : une clé publique ne doit pas servir de secret).
 */
import { createPublicKey, createVerify } from "node:crypto";

export class JwtError extends Error {}

export interface Jwk {
  [k: string]: unknown;
  crv?: string;
  kid?: string;
  use?: string;
  alg?: string;
  kty?: string;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce?: string;
  now?: number;
  /** Tolérance d'horloge en secondes. */
  skew?: number;
}

const b64 = (s: string): Buffer => Buffer.from(s, "base64url");

export function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: Buffer } {
  if (typeof token !== "string" || token.length > 16_000) throw new JwtError("jeton trop long");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new JwtError("jeton mal formé");
  try {
    const header = JSON.parse(b64(parts[0]).toString("utf8"));
    const claims = JSON.parse(b64(parts[1]).toString("utf8"));
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error();
    return { header, claims, signed: `${parts[0]}.${parts[1]}`, signature: b64(parts[2]) };
  } catch {
    throw new JwtError("jeton mal formé");
  }
}

/** Clé du jeu qui convient à l'en-tête (kid, puis algorithme) ; null si aucune. */
export function pickKey(keys: readonly Jwk[], header: Record<string, unknown>): Jwk | null {
  const alg = header.alg;
  const usable = keys.filter((k) => (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === alg) && (alg === "RS256" ? k.kty === "RSA" : k.kty === "EC" && k.crv === "P-256"));
  if (typeof header.kid === "string") return usable.find((k) => k.kid === header.kid) ?? null;
  return usable.length === 1 ? usable[0] : null;
}

export function verifySignature(signed: string, signature: Buffer, alg: string, jwk: Jwk): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const v = createVerify("SHA256");
    v.update(signed);
    return alg === "ES256" ? v.verify({ key, dsaEncoding: "ieee-p1363" }, signature) : v.verify(key, signature);
  } catch {
    return false;
  }
}

/** Contrôle la signature et les revendications ; renvoie les revendications. */
export function verifyIdToken(token: string, keys: readonly Jwk[], o: VerifyOptions): Record<string, unknown> {
  const { header, claims, signed, signature } = decodeJwt(token);
  if (header.alg !== "RS256" && header.alg !== "ES256") throw new JwtError("algorithme non accepté");
  const key = pickKey(keys, header);
  if (!key) throw new JwtError("clé de signature inconnue");
  if (!verifySignature(signed, signature, header.alg, key)) throw new JwtError("signature invalide");

  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const skew = o.skew ?? 60;
  if (claims.iss !== o.issuer) throw new JwtError("émetteur inattendu");
  const aud = claims.aud;
  const auds = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!auds.includes(o.audience)) throw new JwtError("destinataire inattendu");
  if (auds.length > 1 && claims.azp !== o.audience) throw new JwtError("partie autorisée inattendue");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new JwtError("jeton expiré");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new JwtError("jeton pas encore valide");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new JwtError("date d'émission dans le futur");
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 255) throw new JwtError("sujet manquant");
  if (o.nonce !== undefined && claims.nonce !== o.nonce) throw new JwtError("nonce inattendu");
  return claims;
}
