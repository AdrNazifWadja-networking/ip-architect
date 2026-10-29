/** Fenêtre glissante en mémoire : au plus `max` appels par clé et par fenêtre. L'horloge est injectable pour les tests. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Enregistre un appel. Renvoie 0 si autorisé, sinon les millisecondes à attendre. */
  take(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return this.windowMs - (now - recent[0]);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 2000) this.hits.delete(this.hits.keys().next().value as string);
    return 0;
  }
}

import { AI_RATE_MAX, AI_RATE_WINDOW_MS } from "./types";

/** Limiteur partagé par les questions à l'assistant (par utilisateur ; « anon » quand l'application est ouverte). */
export const assistantLimiter = new RateLimiter(AI_RATE_MAX, AI_RATE_WINDOW_MS);
