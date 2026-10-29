/**
 * Client HTTP pour une API « compatible OpenAI » (Ollama, Gemini, LM Studio, OpenRouter…) : un seul code pour tous.
 *
 * - Aucune redirection suivie, délai maximal, taille de réponse bornée.
 * - La clé d'API n'est envoyée que dans l'en-tête Authorization, jamais dans l'URL ni dans un message d'erreur.
 * - Le corps d'erreur du service n'est jamais renvoyé à l'utilisateur (il est tracé, tronqué, dans la console du serveur) :
 *   on le traduit en un code d'erreur de l'application.
 * - `tool_choice` n'est jamais envoyé : Ollama ne le gère pas, et « auto » est le défaut partout.
 */
import { AI_TIMEOUT_MS } from "./types";
import { ApiError } from "../types";

export type FetchFn = typeof fetch;

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini 3 : { google: { thought_signature } } à rejouer tel quel au tour suivant, sinon erreur 400. */
  extra_content?: Record<string, unknown>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MAX_RESPONSE_BYTES = 2_000_000;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function call(ep: { baseUrl: string; apiKey: string }, path: string, init: { method: "GET" | "POST"; body?: unknown }, fetchFn: FetchFn): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(`${ep.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal: ctl.signal,
    });
  } catch (e) {
    if (ctl.signal.aborted || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))) throw new ApiError("aiTimeout", 504);
    throw new ApiError("aiUnreachable", 502, { host: host(ep.baseUrl) });
  } finally {
    clearTimeout(timer);
  }

  let text = "";
  try {
    text = await res.text();
  } catch {
    throw new ApiError("aiBadResponse", 502);
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new ApiError("aiBadResponse", 502);

  if (!res.ok) {
    console.error(`assistant : ${init.method} ${host(ep.baseUrl)}${path} -> ${res.status} ${text.slice(0, 300).replace(/\s+/g, " ")}`);
    if (res.status === 401 || res.status === 403) throw new ApiError("aiAuth", 502);
    if (res.status === 429) throw new ApiError("aiRateLimited", 429);
    if (res.status === 404) throw new ApiError("aiModelNotFound", 502);
    if (res.status === 400 && /(does not|doesn.t|do not|not) support(s|ed)? (tools|function)|tools? (is|are)? ?not supported|tool use is not supported/i.test(text)) throw new ApiError("aiToolsUnsupported", 502);
    throw new ApiError("aiBadResponse", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("aiBadResponse", 502);
  }
}

/** Une réponse du modèle : du texte, ou des appels d'outils à exécuter. */
export async function chatCompletion(ep: LlmEndpoint, messages: LlmMessage[], tools: LlmTool[] | null, fetchFn: FetchFn = fetch): Promise<LlmMessage> {
  const json = (await call(ep, "/chat/completions", {
    method: "POST",
    body: { model: ep.model, messages, temperature: 0.2, ...(tools && tools.length > 0 ? { tools } : {}) },
  }, fetchFn)) as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] };

  const msg = json?.choices?.[0]?.message;
  if (!msg || typeof msg !== "object") throw new ApiError("aiBadResponse", 502);

  const calls: LlmToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((c: unknown, i: number) => {
      const f = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
      if (!f || typeof f.name !== "string") throw new ApiError("aiBadResponse", 502);
      const id = typeof (c as { id?: unknown }).id === "string" && (c as { id: string }).id ? (c as { id: string }).id : `call_${i}`;
      // « arguments » est du JSON en texte ; certains services renvoient déjà un objet
      const args = typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments ?? {});
      const extra = (c as { extra_content?: unknown }).extra_content;
      // rejoué tel quel (jamais interprété) ; borné pour ne pas relayer un objet démesuré
      const keep = extra && typeof extra === "object" && !Array.isArray(extra) && JSON.stringify(extra).length <= 20_000 ? (extra as Record<string, unknown>) : undefined;
      calls.push({ id, type: "function", function: { name: f.name, arguments: args }, ...(keep ? { extra_content: keep } : {}) });
    });
  }
  // contenu : texte, ou liste de morceaux de texte chez certains services
  let content: string | null = null;
  if (typeof msg.content === "string") content = msg.content;
  else if (Array.isArray(msg.content)) {
    content = (msg.content as { text?: unknown }[]).map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  return { role: "assistant", content, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
}

/** Modèles proposés par le service (GET /models). Les préfixes « models/ » (Gemini) sont retirés. */
export async function listModels(ep: { baseUrl: string; apiKey: string }, fetchFn: FetchFn = fetch): Promise<string[]> {
  const json = (await call(ep, "/models", { method: "GET" }, fetchFn)) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] };
  const raw: unknown[] = Array.isArray(json?.data) ? json.data.map((m) => m?.id) : Array.isArray(json?.models) ? json.models.map((m) => m?.name) : [];
  const ids = raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120).map((x) => x.replace(/^models\//, ""));
  if (ids.length === 0 && !Array.isArray(json?.data) && !Array.isArray(json?.models)) throw new ApiError("aiBadResponse", 502);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 300);
}
