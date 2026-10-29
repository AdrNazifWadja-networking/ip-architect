"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/constants";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

/** Application ouverte (aucun compte) : création du premier administrateur, qui active la connexion. */
export function SetupAuth({ codeRequired = false }: { codeRequired?: boolean }) {
  const { t } = useI18n();
  const s = t.users.setup;
  const f = t.users.form;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const json = { "Content-Type": "application/json" };
      const created = await fetch("/api/users", { method: "POST", headers: json, body: JSON.stringify({ username, displayName, password, ...(codeRequired ? { setupCode } : {}) }) });
      const data = (await created.json().catch(() => ({}))) as { error?: string };
      if (!created.ok) throw new Error(data.error ?? s.failed);
      // on connecte tout de suite le nouvel administrateur : la connexion est désormais exigée
      const login = await fetch("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ username, password }) });
      if (!login.ok) {
        window.location.assign("/login");
        return;
      }
      window.location.assign("/utilisateurs");
    } catch (err) {
      setError(err instanceof Error ? err.message : s.failed);
      setBusy(false);
    }
  };

  return (
    <section className="card max-w-xl p-6" aria-labelledby="setup-title">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-warn" />
        <div>
          <h2 id="setup-title" className="text-lg font-bold text-fg">
            {s.title}
          </h2>
          <p className="mt-1 text-sm text-fg2">{s.intro}</p>
          <p className="mt-2 text-xs text-muted">{s.warning}</p>
        </div>
      </div>
      <form onSubmit={submit} className="mt-5 space-y-4" autoComplete="off" aria-label={s.title}>
        {codeRequired && (
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="setup-code">
              {s.code}
            </label>
            <input id="setup-code" required maxLength={64} autoCapitalize="characters" spellCheck={false} value={setupCode} onChange={(e) => setSetupCode(e.target.value)} className="input font-mono" placeholder="XXXX-XXXX-XXXX" />
            <p className="mt-1 text-[11px] text-muted">{s.codeHint}</p>
          </div>
        )}
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="setup-username">
            {f.username}
          </label>
          <input
            id="setup-username"
            required
            maxLength={40}
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input font-mono"
          />
          <p className="mt-1 text-[11px] text-muted">{f.usernameHint}</p>
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="setup-display">
            {f.displayName}
          </label>
          <input id="setup-display" required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="setup-password">
            {f.password}
          </label>
          <input
            id="setup-password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
          <p className="mt-1 text-[11px] text-muted">{format(f.passwordHint, { min: MIN_PASSWORD_LENGTH })}</p>
        </div>
        {error && (
          <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? s.submitting : s.submit}
        </button>
      </form>
    </section>
  );
}
