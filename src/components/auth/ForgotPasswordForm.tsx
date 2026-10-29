"use client";

import { useState } from "react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/constants";
import { RESET_CODE_TTL_MS } from "@/lib/resetTypes";
import { SIGNUP_CODE_LENGTH } from "@/lib/signupTypes";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";

type Step = "email" | "code" | "done" | "restart";

export function ForgotPasswordForm({ available }: { available: boolean }) {
  const { t } = useI18n();
  const r = t.reset;
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = RESET_CODE_TTL_MS / 60_000;

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) throw Object.assign(new Error(data.error ?? r.failed), { apiCode: data.code });
    return data;
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/reset/start", { email });
      setCode("");
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : r.failed);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(r.mismatch);
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/reset/verify", { email, code, newPassword: password });
      setStep("done");
    } catch (err) {
      const c = (err as { apiCode?: string }).apiCode;
      // demande expirée, épuisée ou introuvable : il faut en demander une nouvelle
      if (c === "resetCodeExpired" || c === "resetTooManyAttempts" || c === "resetNoRequest") {
        setStep("restart");
        setCode("");
      } else setError(err instanceof Error ? err.message : r.failed);
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setStep("email");
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
          <h1 className="mt-4 text-xl font-bold text-fg">{available ? r.title : r.unavailableTitle}</h1>
          <p className="mt-1 text-sm text-muted">{available ? r.subtitle : r.unavailableBody}</p>
        </div>

        {available && step === "email" && (
          <form onSubmit={start} className="space-y-4" aria-label={r.title}>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="rs-email">{r.email}</label>
              <input id="rs-email" type="email" required autoFocus maxLength={254} autoCapitalize="none" spellCheck={false} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
            </div>
            {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
            <button type="submit" disabled={busy} className="btn-primary w-full">{busy ? r.sending : r.send}</button>
          </form>
        )}

        {available && step === "code" && (
          <form onSubmit={verify} className="space-y-4" aria-label={r.codeTitle}>
            <h2 className="text-sm font-semibold text-fg">{r.codeTitle}</h2>
            <p className="text-sm text-muted">{format(r.codeHint, { email, minutes })}</p>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="rs-code">{r.code}</label>
              <input
                id="rs-code"
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="rs-pw">{r.newPassword}</label>
                <input id="rs-pw" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label-caps mb-1.5 block" htmlFor="rs-pw2">{r.confirm}</label>
                <input id="rs-pw2" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
              </div>
            </div>
            <p className="text-[11px] text-muted">{format(t.users.form.passwordHint, { min: MIN_PASSWORD_LENGTH })}</p>
            {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
            <div className="flex gap-3">
              <button type="button" onClick={again} className="btn-ghost">{r.changeAddress}</button>
              <button type="submit" disabled={busy || code.length !== SIGNUP_CODE_LENGTH} className="btn-primary flex-1">{busy ? r.saving : r.save}</button>
            </div>
          </form>
        )}

        {available && step === "restart" && (
          <div className="space-y-4" role="alert">
            <h2 className="text-sm font-semibold text-warn">{r.restartTitle}</h2>
            <p className="text-sm text-muted">{format(r.restartBody, { minutes })}</p>
            <button type="button" onClick={again} className="btn-primary w-full">{r.restart}</button>
          </div>
        )}

        {available && step === "done" && (
          <div className="space-y-4" role="status">
            <h2 className="text-sm font-semibold text-ok">{r.doneTitle}</h2>
            <p className="text-sm text-muted">{r.doneBody}</p>
            <a href="/login" className="btn-primary w-full">{r.goLogin}</a>
          </div>
        )}

        {step !== "done" && (
          <p className="text-center text-sm text-muted">
            <a href="/login" className="font-medium text-brand-soft hover:underline">{r.backToLogin}</a>
          </p>
        )}
      </div>
    </div>
  );
}
