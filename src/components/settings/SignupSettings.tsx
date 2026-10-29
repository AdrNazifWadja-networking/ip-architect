"use client";

import { useState } from "react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { SMTP_PRESETS, SMTP_SECURITY, type SignupConfig, type SmtpSecurity } from "@/lib/signupTypes";

export function SignupSettings({ initial }: { initial: SignupConfig }) {
  const { t } = useI18n();
  const a = t.signupAdmin;
  const [cfg, setCfg] = useState<SignupConfig>(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [domains, setDomains] = useState(initial.domains.join(", "));
  const [consoleMode, setConsoleMode] = useState(initial.consoleMode);
  const [host, setHost] = useState(initial.smtp.host);
  const [port, setPort] = useState(String(initial.smtp.port));
  const [security, setSecurity] = useState<SmtpSecurity>(initial.smtp.security);
  const [user, setUser] = useState(initial.smtp.user);
  const [password, setPassword] = useState("");
  const [clearPw, setClearPw] = useState(false);
  const [from, setFrom] = useState(initial.smtp.from);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const preset = (k: keyof typeof SMTP_PRESETS) => {
    setHost(SMTP_PRESETS[k].host);
    setPort(String(SMTP_PRESETS[k].port));
    setSecurity(SMTP_PRESETS[k].security);
  };

  const call = async (url: string, method: string, body: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(data.error ?? t.errors.internal);
    return data;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    try {
      const body: Record<string, unknown> = { enabled, domains, consoleMode, smtpHost: host, smtpPort: port, smtpSecurity: security, smtpUser: user, smtpFrom: from };
      if (clearPw) body.smtpPassword = "";
      else if (password) body.smtpPassword = password;
      const d = (await call("/api/settings/signup", "PATCH", body)) as { config: SignupConfig };
      setCfg(d.config);
      setPassword("");
      setClearPw(false);
      setMsg({ ok: true, text: a.saved });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t.errors.internal });
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setBusy("test");
    setMsg(null);
    try {
      await call("/api/settings/signup/test", "POST", { to: testTo });
      setMsg({ ok: true, text: format(a.testOk, { email: testTo }) });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t.errors.internal });
    } finally {
      setBusy("");
    }
  };

  const label = "mb-1 block text-xs font-medium text-fg2";
  return (
    <section className="mt-6 space-y-4">
      <form onSubmit={save} className="card space-y-4 p-5" aria-label={a.title}>
        <div>
          <h2 className="text-sm font-semibold text-fg">{a.title}</h2>
          <p className="mt-1 text-sm text-muted">{a.intro}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {a.enabled}
        </label>
        <div>
          <label className={label} htmlFor="su-domains">{a.domains}</label>
          <input id="su-domains" className="input" value={domains} onChange={(e) => setDomains(e.target.value)} spellCheck={false} placeholder="monentreprise.com" />
          <p className="mt-1 text-[11px] text-muted">{a.domainsHint}</p>
        </div>

        <h3 className="pt-2 text-sm font-medium text-fg">{a.smtpTitle}</h3>
        <div role="group" aria-label={a.smtpTitle} className="flex flex-wrap gap-2">
          {(["gmail", "outlook", "custom"] as const).map((k) => (
            <button key={k} type="button" onClick={() => preset(k)} className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg2 hover:bg-panel2">
              {a.presets[k]}
            </button>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <label className={label} htmlFor="smtp-host">{a.host}</label>
            <input id="smtp-host" className="input font-mono" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <label className={label} htmlFor="smtp-port">{a.port}</label>
            <input id="smtp-port" className="input font-mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="smtp-sec">{a.security}</label>
            <select id="smtp-sec" className="input" value={security} onChange={(e) => setSecurity(e.target.value as SmtpSecurity)}>
              {SMTP_SECURITY.map((s) => <option key={s} value={s}>{a.securities[s]}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="smtp-user">{a.user}</label>
            <input id="smtp-user" className="input" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <label className={label} htmlFor="smtp-pw">{a.password}</label>
            <input id="smtp-pw" type="password" className="input font-mono" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="mt-1 text-[11px] text-muted">{cfg.smtp.hasPassword && !clearPw ? a.passwordSaved : a.passwordNone}</p>
            {cfg.smtp.hasPassword && (
              <label className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                <input type="checkbox" checked={clearPw} onChange={(e) => setClearPw(e.target.checked)} /> {a.clearPassword}
              </label>
            )}
          </div>
          <div className="md:col-span-3">
            <label className={label} htmlFor="smtp-from">{a.from}</label>
            <input id="smtp-from" type="email" className="input" value={from} onChange={(e) => setFrom(e.target.value)} spellCheck={false} />
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm text-fg2">
          <input type="checkbox" className="mt-1" checked={consoleMode} onChange={(e) => setConsoleMode(e.target.checked)} />
          <span>
            {a.consoleMode}
            <span className="block text-[11px] text-warn">{a.consoleWarning}</span>
          </span>
        </label>

        {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-ok" : "text-sm text-bad"}>{msg.text}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy !== ""} className="btn-primary">{a.save}</button>
          <p className="text-[11px] text-muted">{a.secretNote}</p>
        </div>

        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-medium text-fg">{a.testTitle}</h3>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <label className={label} htmlFor="smtp-test">{a.testTo}</label>
              <input id="smtp-test" type="email" className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            </div>
            <button type="button" onClick={test} disabled={busy !== "" || !testTo} className="btn-ghost">{busy === "test" ? a.testing : a.testSend}</button>
          </div>
        </div>
      </form>

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-fg">{a.guideTitle}</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">{a.guide.map((x) => <li key={x}>{x}</li>)}</ol>
      </div>
    </section>
  );
}
