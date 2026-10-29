/** Types et constantes de l'assistant IA, sans accès à la base : importables côté navigateur. */

export const AI_PROVIDERS = ["ollama", "gemini", "custom"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const isAiProvider = (v: unknown): v is AiProvider => typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);

/**
 * Valeurs proposées par défaut (le serveur accepte n'importe quelle API « compatible OpenAI »).
 * - Ollama : serveur local, aucune clé (Ollama ignore la clé).
 * - Gemini : point d'entrée compatible OpenAI de l'API Gemini ; clé gratuite à créer dans Google AI Studio.
 * Le nom du modèle se choisit dans la liste proposée par le service (bouton « Tester la connexion »).
 */
export const AI_PRESETS: Record<AiProvider, { baseUrl: string; model: string; needsKey: boolean }> = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "", needsKey: false },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", needsKey: true },
  custom: { baseUrl: "", model: "", needsKey: false },
};

/** Réglages visibles par l'interface : la clé d'API n'en fait JAMAIS partie (seulement « hasKey »). */
export interface AiConfig {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface UpdateAiConfigInput {
  enabled?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  /** undefined = inchangée ; "" = effacée ; sinon nouvelle clé. */
  apiKey?: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolTrace {
  name: string;
  /** Arguments donnés par le modèle (jamais de secret : les outils sont en lecture seule sur les données du projet). */
  args: Record<string, unknown>;
  /** true si l'outil a répondu par une erreur (le modèle a pu se corriger). */
  failed?: boolean;
}

export interface AssistantReply {
  answer: string;
  tools: ToolTrace[];
  model: string;
}

export const AI_MAX_MESSAGES = 20;
export const AI_MAX_MESSAGE_CHARS = 4000;
export const AI_MAX_TOOL_ROUNDS = 6;
export const AI_MAX_TOOLS_PER_ROUND = 8;
export const AI_TOOL_RESULT_MAX_CHARS = 12_000;
export const AI_TIMEOUT_MS = 90_000;
/** Questions par fenêtre glissante et par utilisateur (protège le quota gratuit contre un emballement). */
export const AI_RATE_MAX = 20;
export const AI_RATE_WINDOW_MS = 5 * 60_000;
