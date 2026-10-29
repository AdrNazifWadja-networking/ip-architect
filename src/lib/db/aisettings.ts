/**
 * Réglages de l'assistant IA (table « settings », clé/valeur). La clé d'API est stockée ici, en clair, comme le reste de
 * la base : elle n'est JAMAIS renvoyée par l'API (seulement « une clé est enregistrée »), et la sauvegarde la retire.
 */
import { getDb, type Db } from "./index";
import { AI_PRESETS, isAiProvider, type AiConfig, type AiProvider, type UpdateAiConfigInput } from "../ai/types";
import { ApiError } from "../types";

const K = { enabled: "ai_enabled", provider: "ai_provider", baseUrl: "ai_base_url", model: "ai_model", apiKey: "ai_api_key" } as const;
/** Clé retirée de toute copie de la base. */
export const AI_SECRET_SETTING = K.apiKey;

const read = (db: Db, key: string): string | null => {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
};
const write = (db: Db, key: string, value: string) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export function getAiConfig(db: Db = getDb()): AiConfig {
  const p = read(db, K.provider);
  const provider: AiProvider = isAiProvider(p) ? p : "ollama";
  return {
    enabled: read(db, K.enabled) === "1",
    provider,
    baseUrl: read(db, K.baseUrl) ?? AI_PRESETS[provider].baseUrl,
    model: read(db, K.model) ?? AI_PRESETS[provider].model,
    hasKey: (read(db, K.apiKey) ?? "") !== "",
  };
}

/** La clé d'API, pour le seul client HTTP du serveur. */
export function getAiSecret(db: Db = getDb()): string {
  return read(db, K.apiKey) ?? "";
}

/** URL de base : http(s) seulement, sans identifiants intégrés, sans espace ; la barre finale est retirée. */
export function cleanBaseUrl(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 200 || /[\s\u0000-\u001f]/.test(s)) throw new ApiError("aiInvalidConfig", 422, { field: "URL" });
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ApiError("aiInvalidConfig", 422, { field: "URL" });
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) {
    throw new ApiError("aiInvalidConfig", 422, { field: "URL" });
  }
  return s.replace(/\/+$/, "");
}

export function cleanModel(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length > 100 || /[\s\u0000-\u001f]/.test(s)) throw new ApiError("aiInvalidConfig", 422, { field: "model" });
  return s.replace(/^models\//, "");
}

export function cleanApiKey(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length > 300 || /[\s\u0000-\u001f]/.test(s)) throw new ApiError("aiInvalidConfig", 422, { field: "API key" });
  return s;
}

/** Modification partielle, validée en entier avant la première écriture, dans une transaction. */
export function updateAiConfig(input: UpdateAiConfigInput, db: Db = getDb()): AiConfig {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);
  const cur = getAiConfig(db);

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new ApiError("invalidBody", 400);
  if (input.provider !== undefined && !isAiProvider(input.provider)) throw new ApiError("aiInvalidConfig", 422, { field: "provider" });
  const provider = (input.provider as AiProvider | undefined) ?? cur.provider;
  const baseUrl = input.baseUrl !== undefined ? cleanBaseUrl(input.baseUrl) : cur.baseUrl;
  const model = input.model !== undefined ? cleanModel(input.model) : cur.model;
  const apiKey = input.apiKey !== undefined ? cleanApiKey(input.apiKey) : undefined;
  const enabled = input.enabled !== undefined ? (input.enabled as boolean) : cur.enabled;

  // activer sans adresse, sans modèle ou (Gemini) sans clé : refusé tout de suite plutôt qu'à la première question
  if (enabled) {
    const hasKey = apiKey !== undefined ? apiKey !== "" : cur.hasKey;
    if (!baseUrl) throw new ApiError("aiNotConfigured", 409);
    if (!model) throw new ApiError("aiNotConfigured", 409);
    if (AI_PRESETS[provider].needsKey && !hasKey) throw new ApiError("aiNotConfigured", 409);
  }

  db.transaction(() => {
    write(db, K.provider, provider);
    write(db, K.baseUrl, baseUrl);
    write(db, K.model, model);
    write(db, K.enabled, enabled ? "1" : "0");
    if (apiKey !== undefined) write(db, K.apiKey, apiKey);
  })();
  return getAiConfig(db);
}
