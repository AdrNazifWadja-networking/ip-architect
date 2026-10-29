"use client";

import { useState } from "react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";

export function LoginForm({ next, signup = false, reset = false, oidcLabel = null, ssoError }: { next: string; signup?: boolean; reset?: boolean; oidcLabel?: string | null; ssoError?: string }) {
  const { t } = useI18n();
  const a = t.auth;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(ssoError ? ((t.errors as Record<string, string>)[ssoError] ?? null) : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? a.failed);
      // rechargement complet : le menu et l'en-tête se construisent avec le nouvel utilisateur
      window.location.assign(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : a.failed);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <form onSubmit={submit} className="card w-full max-w-sm space-y-5 p-7" aria-label={a.title}>
        <div>
          <div className="text-[17px] font-bold tracking-wide text-fg">IP ARCHITECT</div>
          <h1 className="mt-4 text-xl font-bold text-fg">{a.title}</h1>
          <p className="mt-1 text-sm text-muted">{a.subtitle}</p>
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="login-username">
            {a.username}
          </label>
          <input
            id="login-username"
            autoFocus
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input"
          />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="login-password">
            {a.password}
          </label>
          <input
            id="login-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </div>
        {error && (
          <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? a.signingIn : a.signIn}
        </button>
        {oidcLabel && (
          <div className="space-y-3">
            <div className="text-center text-xs uppercase tracking-wide text-muted">{a.or}</div>
            <a href="/api/auth/oidc/start" className="btn-secondary block w-full text-center">
              {format(a.ssoWith, { label: oidcLabel })}
            </a>
          </div>
        )}
        {reset && (
          <p className="text-center text-sm">
            <a href="/mot-de-passe-oublie" className="font-medium text-brand-soft hover:underline">
              {a.forgotPassword}
            </a>
          </p>
        )}
        {signup && (
          <p className="text-center text-sm text-muted">
            {a.noAccount}{" "}
            <a href="/inscription" className="font-medium text-brand-soft hover:underline">
              {a.createAccount}
            </a>
          </p>
        )}
      </form>
    </div>
  );
}
