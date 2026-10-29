"use client";

import { useState } from "react";
import type { SessionUser } from "@/lib/types";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/constants";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

/** « Mon compte » : qui je suis, et changer mon mot de passe. */
export function AccountPanel({ me }: { me: SessionUser | null }) {
  const { t } = useI18n();
  const a = t.users.account;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!me) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setMsg({ ok: false, text: a.mismatch });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? a.failed);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: a.changed });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : a.failed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card max-w-xl p-5" aria-labelledby="account-title">
      <h2 id="account-title" className="card-title">
        {a.title}
      </h2>
      <p className="mt-1 text-sm text-muted">{format(a.signedInAs, { name: me.displayName, role: t.users.roles[me.role] })}</p>
      <form onSubmit={submit} className="mt-4 space-y-3" aria-label={a.changePassword}>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="acc-current">
            {a.current}
          </label>
          <input id="acc-current" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="acc-next">
            {a.next}
          </label>
          <input
            id="acc-next"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="input"
          />
          <p className="mt-1 text-[11px] text-muted">{format(t.users.form.passwordHint, { min: MIN_PASSWORD_LENGTH })}</p>
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="acc-confirm">
            {a.confirm}
          </label>
          <input id="acc-confirm" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
        </div>
        {msg && (
          <div
            role={msg.ok ? "status" : "alert"}
            className={`rounded-md border px-3 py-2 text-sm ${msg.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-bad/40 bg-bad/10 text-bad"}`}
          >
            {msg.text}
          </div>
        )}
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? a.submitting : a.submit}
        </button>
      </form>
    </section>
  );
}
