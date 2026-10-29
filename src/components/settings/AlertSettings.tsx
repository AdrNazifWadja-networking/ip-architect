"use client";

import { useState } from "react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { ALERT_MAX_INTERVAL_MIN, ALERT_MIN_INTERVAL_MIN, type AlertConfig } from "@/lib/alertTypes";

export function AlertSettings({ initial }: { initial: AlertConfig }) {
  const { t, locale } = useI18n();
  const a = t.alertsAdmin;
  const [cfg, setCfg] = useState<AlertConfig>(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [recipients, setRecipients] = useState(initial.recipients.join(", "));
  const [minSeverity, setMinSeverity] = useState(initial.minSeverity);
  const [interval, setIntervalMin] = useState(String(initial.intervalMin));
  const [perProject, setPerProject] = useState<Record<number, string>>(() => Object.fromEntries(initial.projectRecipients.map((p) => [p.projectId, p.recipients.join(", ")])));
  const [mailLocale, setMailLocale] = useState(initial.locale);
  const [busy, setBusy] = useState<"" | "save" | "run">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const call = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(data.error ?? t.errors.internal);
    return data;
  };
  const fail = (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : t.errors.internal });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    try {
      const d = (await call("/api/settings/alerts", "PATCH", { enabled, recipients, minSeverity, intervalMin: Number(interval), locale: mailLocale, projectRecipients: cfg.projectRecipients.map((p) => ({ projectId: p.projectId, recipients: perProject[p.projectId] ?? "" })) })) as { config: AlertConfig };
      setCfg(d.config);
      setMsg({ ok: true, text: a.saved });
    } catch (err) {
      fail(err);
    } finally {
      setBusy("");
    }
  };

  const run = async () => {
    setBusy("run");
    setMsg(null);
    try {
      const d = (await call("/api/settings/alerts/run", "POST")) as { config: AlertConfig; result: { fresh: number; sent: number; error: string | null } };
      setCfg(d.config);
      setMsg({ ok: !d.result.error, text: d.result.error ? a.runFailed : d.result.fresh === 0 ? a.runNothing : format(a.runDone, { n: d.result.fresh, sent: d.result.sent }) });
    } catch (err) {
      fail(err);
    } finally {
      setBusy("");
    }
  };

  const last = cfg.lastRun;
  const when = (iso: string) => new Date(iso).toLocaleString(locale === "en" ? "en-US" : "fr-FR");

  return (
    <section className="mt-6 space-y-4">
      <form onSubmit={save} className="card space-y-4 p-5" aria-label={a.title}>
        <div>
          <h2 className="text-sm font-semibold text-fg">{a.title}</h2>
          <p className="mt-1 text-sm text-muted">{a.intro}</p>
        </div>
        {!cfg.mailReady && (
          <div role="note" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">{a.noMail}</div>
        )}
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {a.enabled}
        </label>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="al-rcpt">{a.recipients}</label>
          <input id="al-rcpt" className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="admin@monentreprise.com, noc@monentreprise.com" autoCapitalize="none" spellCheck={false} />
          <p className="mt-1 text-[11px] text-muted">{a.recipientsHint}</p>
        </div>
        {cfg.projectRecipients.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="label-caps mb-1.5 block">{a.projectRecipients}</legend>
            <p className="text-[11px] text-muted">{a.projectRecipientsHint}</p>
            <ul className="space-y-2">
              {cfg.projectRecipients.map((p) => (
                <li key={p.projectId} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-center">
                  <label htmlFor={`al-p-${p.projectId}`} className="truncate text-sm text-fg">{p.name}</label>
                  <input
                    id={`al-p-${p.projectId}`}
                    className="input"
                    value={perProject[p.projectId] ?? ""}
                    onChange={(e) => setPerProject({ ...perProject, [p.projectId]: e.target.value })}
                    placeholder="contact@client.com"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="al-sev">{a.minSeverity}</label>
            <select id="al-sev" className="input" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as typeof minSeverity)}>
              <option value="critical">{a.sevCritical}</option>
              <option value="warning">{a.sevWarning}</option>
            </select>
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="al-int">{a.interval}</label>
            <input id="al-int" type="number" className="input" min={ALERT_MIN_INTERVAL_MIN} max={ALERT_MAX_INTERVAL_MIN} step={1} value={interval} onChange={(e) => setIntervalMin(e.target.value)} />
          </div>
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="al-loc">{a.language}</label>
            <select id="al-loc" className="input" value={mailLocale} onChange={(e) => setMailLocale(e.target.value as "fr" | "en")}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
        <p className="text-[11px] text-muted">{a.once}</p>
        {msg && (
          <div role={msg.ok ? "status" : "alert"} className={`rounded-md border px-3 py-2 text-sm ${msg.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-bad/40 bg-bad/10 text-bad"}`}>{msg.text}</div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy !== ""} className="btn-primary">{busy === "save" ? a.saving : a.save}</button>
          <button type="button" disabled={busy !== "" || !cfg.enabled} onClick={run} className="btn-ghost">{busy === "run" ? a.running : a.runNow}</button>
          <span className="text-xs text-muted">
            {last ? format(a.lastRun, { when: when(last.at), n: last.fresh, sent: last.sent }) + (last.error ? ` — ${a.lastError}` : "") : a.neverRun}
          </span>
        </div>
      </form>
    </section>
  );
}
