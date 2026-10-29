"use client";

import { useEffect, useState } from "react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/constants";
import { SIGNUP_CODE_LENGTH, SIGNUP_CODE_TTL_MS } from "@/lib/signupTypes";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";

type Step = "form" | "code" | "expired";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function SignupForm({ open, domains }: { open: boolean; domains: string[] }) {
  const { t } = useI18n();
  const s = t.signup;
  const [step, setStep] = useState<Step>("form");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(SIGNUP_CODE_TTL_MS);
  const [deadline, setDeadline] = useState(0);
  const minutes = SIGNUP_CODE_TTL_MS / 60_000;

  // compte à rebours (affichage seulement : c'est le serveur qui fait foi sur l'expiration)
  useEffect(() => {
    if (step !== "code") return;
    const id = setInterval(() => {
      const rest = deadline - Date.now();
      setLeft(rest);
      if (rest <= 0) {
        setStep("expired");
        setCode("");
      }
    }, 500);
    return () => clearInterval(id);
  }, [step, deadline]);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; expiresInMs?: number };
    if (!res.ok) throw Object.assign(new Error(data.error ?? s.failed), { apiCode: data.code });
    return data;
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(s.mismatch);
    setBusy(true);
    setError(null);
    try {
      const d = await post("/api/auth/register/start", { email, username, displayName, password });
      const ttl = d.expiresInMs ?? SIGNUP_CODE_TTL_MS;
      setDeadline(Date.now() + ttl);
      setLeft(ttl);
      setCode("");
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : s.failed);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/register/verify", { email, code });
      window.location.assign("/"); // rechargement complet : la session vient d'être ouverte
    } catch (err) {
      const c = (err as { apiCode?: string }).apiCode;
      // code expiré ou demande supprimée côté serveur : il faut recommencer
      if (c === "signupCodeExpired" || c === "signupTooManyAttempts" || c === "signupNoRequest") {
        setStep("expired");
        setCode("");
      } else setError(err instanceof Error ? err.message : s.failed);
      setBusy(false);
    }
  };

  const restart = () => {
    setStep("form");
    setError(null);
    setPassword("");
    setConfirm("");
    setCode("");
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="card w-full max-w-md space-y-5 p-7">
        <div>
          <div className="text-[17px] font-bold tracking-wide text-fg">IP ARCHITECT</div>
          <h1 className="mt-4 text-xl font-bold text-fg">{open ? s.title : s.closedTitle}</h1>
          <p className="mt-1 text-sm text-muted">{open ? s.subtitle : s.closedBody}</p>
        </div>

        {open && step === "form" && (
          <form onSubmit={start} className="space-y-4" autoComplete="off" aria-label={s.title}>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="su-email">{s.email}</label>
              <input id="su-email" type="email" required autoFocus maxLength={254} autoCapitalize="none" spellCheck={false} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
              {domains.length > 0 && <p className="mt-1 text-[11px] text-muted">@{domains.join(", @")}</p>}
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="su-username">{s.username}</label>
              <input id="su-username" required maxLength={40} autoCapitalize="none" spellCheck={false} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="input font-mono" />
              <p className="mt-1 text-[11px] text-muted">{s.usernameHint}</p>
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="su-name">{s.displayName}</label>
              <input id="su-name" required maxLength={80} autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="su-pw">{s.password}</label>
                <input id="su-pw" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="su-pw2">{s.confirm}</label>
                <input id="su-pw2" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
              </div>
            </div>
            <p className="text-[11px] text-muted">{format(t.users.form.passwordHint, { min: MIN_PASSWORD_LENGTH })} {s.roleNote}</p>
            {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
            <button type="submit" disabled={busy} className="btn-primary w-full">{busy ? s.sending : s.send}</button>
          </form>
        )}

        {open && step === "code" && (
          <form onSubmit={verify} className="space-y-4" aria-label={s.codeTitle}>
            <h2 className="text-sm font-semibold text-fg">{s.codeTitle}</h2>
            <p className="text-sm text-muted">{format(s.codeHint, { email, minutes })}</p>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="su-code">{s.code}</label>
              <input
                id="su-code"
                required
                autoFocus
                inputMode="numeric"
                pattern={`\\d{${SIGNUP_CODE_LENGTH}}`}
                maxLength={SIGNUP_CODE_LENGTH}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, SIGNUP_CODE_LENGTH))}
                className="input text-center font-mono text-xl tracking-[0.4em]"
              />
            </div>
            <p className={left < 30_000 ? "text-sm font-medium text-warn" : "text-sm text-muted"} role="timer" aria-live="off">{format(s.remaining, { time: mmss(left) })}</p>
            {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
            <div className="flex gap-3">
              <button type="button" onClick={restart} className="btn-ghost">{s.changeAddress}</button>
              <button type="submit" disabled={busy || code.length !== SIGNUP_CODE_LENGTH} className="btn-primary flex-1">{busy ? s.verifying : s.verify}</button>
            </div>
          </form>
        )}

        {open && step === "expired" && (
          <div className="space-y-4" role="alert">
            <h2 className="text-sm font-semibold text-warn">{s.expiredTitle}</h2>
            <p className="text-sm text-muted">{format(s.expiredBody, { minutes })}</p>
            <button type="button" onClick={restart} className="btn-primary w-full">{s.restart}</button>
          </div>
        )}

        <p className="text-center text-sm text-muted">
          {s.haveAccount}{" "}
          <a href="/login" className="font-medium text-brand-soft hover:underline">{s.signIn}</a>
        </p>
      </div>
    </div>
  );
}
