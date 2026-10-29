/**
 * Limitation des tentatives de connexion : après `max` échecs dans `windowMs`, la clé est bloquée `lockMs`.
 * En mémoire (une instance du serveur) ; l'horloge est injectable pour les tests.
 */
export class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  private readonly locked = new Map<string, number>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly lockMs = 15 * 60_000,
  ) {}

  /** Millisecondes de blocage restantes (0 = autorisé). */
  remaining(key: string, now = Date.now()): number {
    const until = this.locked.get(key);
    if (until === undefined) return 0;
    if (until <= now) {
      this.locked.delete(key);
      return 0;
    }
    return until - now;
  }

  fail(key: string, now = Date.now()): void {
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    if (recent.length >= this.max) {
      this.locked.set(key, now + this.lockMs);
      this.fails.delete(key);
    } else this.fails.set(key, recent);
    // la table ne doit pas grossir sans limite si quelqu'un essaie des milliers d'identifiants
    if (this.fails.size > 5000) this.fails.delete(this.fails.keys().next().value as string);
    if (this.locked.size > 5000) this.locked.delete(this.locked.keys().next().value as string);
  }

  success(key: string): void {
    this.fails.delete(key);
    this.locked.delete(key);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ipArchitectThrottle: LoginThrottle | undefined;
}

/** Instance unique du serveur (survit au rechargement à chaud). */
export function getThrottle(): LoginThrottle {
  return (globalThis.__ipArchitectThrottle ??= new LoginThrottle());
}
