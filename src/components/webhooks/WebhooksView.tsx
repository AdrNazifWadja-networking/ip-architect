"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import type { DeliveryInfo, WebhookInfo } from "@/lib/webhookTypes";
import { WEBHOOK_CRUD, WEBHOOK_ENTITIES, WEBHOOK_NAME_MAX, WEBHOOK_URL_MAX } from "@/lib/webhookTypes";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

const VERIFY = `const crypto = require("node:crypto");
// timestamp = en-tête X-IPA-Timestamp, body = corps brut de la requête
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(timestamp + "." + body).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); // signature = en-tête X-IPA-Signature`;

async function call<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data;
}

export function WebhooksView({ webhooks }: { webhooks: WebhookInfo[] }) {
  const router = useRouter();
  const { t } = useI18n();
  const w = t.webhooks;
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryInfo[]>([]);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [allEvents, setAllEvents] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : w.failed);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (ev: string) => {
    const next = new Set(picked);
    if (next.has(ev)) next.delete(ev);
    else next.add(ev);
    setPicked(next);
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await call<{ secret: string }>("/api/webhooks", "POST", { name, url, events: allEvents ? ["*"] : [...picked] }, w.failed);
      setSecret(r.secret);
      setCopied(false);
      setName("");
      setUrl("");
    });
  };

  const showDeliveries = async (id: number) => {
    if (open === id) return setOpen(null);
    await run(async () => {
      const r = await call<{ deliveries: DeliveryInfo[] }>(`/api/webhooks/${id}/deliveries`, "GET", undefined, w.failed);
      setDeliveries(r.deliveries);
      setOpen(id);
    });
  };

  const errLabel = (code: string | null) => (code ? ((w.deliveries.errors as Record<string, string>)[code] ?? code) : "—");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{w.hint}</p>

      {error && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>
      )}
      {info && <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">{info}</div>}

      {secret && (
        <div role="alert" className="card border-warn/50 p-5">
          <h2 className="card-title">{w.secret.title}</h2>
          <p className="mb-3 mt-1 text-sm text-muted">{w.secret.once}</p>
          <code className="block break-all rounded-md bg-panel2 p-3 font-mono text-sm text-fg">{secret}</code>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
              }}
            >
              {copied ? w.secret.copied : w.secret.copy}
            </button>
            <button type="button" className="btn-primary" onClick={() => setSecret(null)}>{w.secret.close}</button>
          </div>
        </div>
      )}

      <section className="card p-5">
        <h2 className="card-title mb-4">{w.form.title}</h2>
        <form onSubmit={create} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="wh-name">{w.form.name}</label>
              <input id="wh-name" value={name} maxLength={WEBHOOK_NAME_MAX} onChange={(e) => setName(e.target.value)} className="input" required />
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="wh-url">{w.form.url}</label>
              <input id="wh-url" type="url" value={url} maxLength={WEBHOOK_URL_MAX} onChange={(e) => setUrl(e.target.value)} className="input font-mono" placeholder="https://" required />
              <p className="mt-1 text-xs text-muted">{w.form.urlHint}</p>
            </div>
          </div>
          <fieldset>
            <legend className="label-caps mb-1.5">{w.form.events}</legend>
            <div className="mb-2 flex gap-4 text-sm text-fg2">
              <label className="flex items-center gap-2"><input type="radio" checked={allEvents} onChange={() => setAllEvents(true)} />{w.form.all}</label>
              <label className="flex items-center gap-2"><input type="radio" checked={!allEvents} onChange={() => setAllEvents(false)} />{w.form.chosen}</label>
            </div>
            {!allEvents && (
              <div className="space-y-1.5 rounded-md border border-line p-3 text-sm">
                {WEBHOOK_ENTITIES.map((en) => (
                  <div key={en} className="flex flex-wrap items-center gap-4">
                    <span className="w-40 font-medium text-fg">{t.audit.entities[en]}</span>
                    {WEBHOOK_CRUD.map((a) => (
                      <label key={a} className="flex items-center gap-1.5 text-fg2">
                        <input type="checkbox" checked={picked.has(`${en}.${a}`)} onChange={() => toggle(`${en}.${a}`)} />
                        {w.form.actions[a]}
                      </label>
                    ))}
                  </div>
                ))}
                {(["plan.apply", "csv.import"] as const).map((ev) => (
                  <label key={ev} className="mr-4 inline-flex items-center gap-1.5 text-fg2">
                    <input type="checkbox" checked={picked.has(ev)} onChange={() => toggle(ev)} />
                    {w.form.special[ev]}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <button type="submit" disabled={busy || (!allEvents && picked.size === 0)} className="btn-primary">{busy ? w.form.adding : w.form.add}</button>
        </form>
      </section>

      <section className="card overflow-x-auto">
        {webhooks.length === 0 ? (
          <p className="p-5 text-sm text-muted">{w.empty}</p>
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-4 py-3 font-medium">{w.columns.name}</th>
                <th className="px-4 py-3 font-medium">{w.columns.url}</th>
                <th className="px-4 py-3 font-medium">{w.columns.events}</th>
                <th className="px-4 py-3 font-medium">{w.columns.deliveries}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {webhooks.map((h) => (
                <tr key={h.id} className="align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-fg">{h.name}</div>
                    <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${h.active ? "bg-ok/15 text-ok" : "bg-neutral/20 text-muted"}`}>
                      {h.active ? w.state.active : w.state.inactive}
                    </span>
                  </td>
                  <td className="max-w-[260px] break-all px-4 py-3 font-mono text-xs text-fg2">{h.url}</td>
                  <td className="px-4 py-3 text-xs text-fg2">{h.events.join(", ")}</td>
                  <td className="px-4 py-3 text-xs text-muted">{format(w.stats, { success: h.success, pending: h.pending, failed: h.failed })}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const r = await call<{ delivery: DeliveryInfo }>(`/api/webhooks/${h.id}/test`, "POST", undefined, w.failed);
                            const d = r.delivery;
                            if (d.status === "success") setInfo(format(w.testOk, { code: d.responseCode ?? 200 }));
                            else setError(format(w.testFailed, { reason: d.responseCode ? `HTTP ${d.responseCode}` : errLabel(d.error) }));
                          })
                        }
                      >
                        {w.actions.test}
                      </button>
                      <button type="button" className="btn-ghost" disabled={busy} onClick={() => void run(() => call(`/api/webhooks/${h.id}`, "PATCH", { active: !h.active }, w.failed).then(() => undefined))}>
                        {h.active ? w.actions.deactivate : w.actions.activate}
                      </button>
                      <button type="button" className="btn-ghost" disabled={busy} onClick={() => void showDeliveries(h.id)}>
                        {open === h.id ? w.actions.hide : w.actions.deliveries}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(w.actions.regenerateConfirm)) {
                            void run(async () => {
                              const r = await call<{ secret: string }>(`/api/webhooks/${h.id}/secret`, "POST", undefined, w.failed);
                              setSecret(r.secret);
                              setCopied(false);
                            });
                          }
                        }}
                      >
                        {w.actions.regenerate}
                      </button>
                      <button
                        type="button"
                        aria-label={`${w.actions.delete} ${h.name}`}
                        disabled={busy}
                        className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-40"
                        onClick={() => {
                          if (window.confirm(format(w.actions.deleteConfirm, { name: h.name }))) {
                            void run(() => call(`/api/webhooks/${h.id}`, "DELETE", undefined, w.failed).then(() => undefined));
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {open === h.id && (
                      <div className="mt-3 rounded-md border border-line p-3 text-left">
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{w.deliveries.title}</h3>
                        {deliveries.length === 0 ? (
                          <p className="text-xs text-muted">{w.deliveries.empty}</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-muted">
                                <th className="py-1 pr-2 font-medium">{w.deliveries.at}</th>
                                <th className="py-1 pr-2 font-medium">{w.deliveries.event}</th>
                                <th className="py-1 pr-2 font-medium">{w.deliveries.status}</th>
                                <th className="py-1 pr-2 font-medium">{w.deliveries.attempts}</th>
                                <th className="py-1 pr-2 font-medium">{w.deliveries.code}</th>
                                <th className="py-1 pr-2 font-medium">{w.deliveries.error}</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {deliveries.map((d) => (
                                <tr key={d.id} className="border-t border-line">
                                  <td className="py-1 pr-2 text-muted">{d.createdAt.replace("T", " ").slice(0, 19)}</td>
                                  <td className="py-1 pr-2 font-mono">{d.event}</td>
                                  <td className="py-1 pr-2">
                                    <span className={d.status === "success" ? "text-ok" : d.status === "failed" ? "text-bad" : "text-warn"}>{w.status[d.status]}</span>
                                  </td>
                                  <td className="py-1 pr-2">{d.attempts}</td>
                                  <td className="py-1 pr-2">{d.responseCode ?? "—"}</td>
                                  <td className="py-1 pr-2">{errLabel(d.error)}</td>
                                  <td className="py-1 text-right">
                                    <button
                                      type="button"
                                      className="text-brand-soft hover:underline"
                                      disabled={busy}
                                      onClick={() =>
                                        void run(async () => {
                                          await call(`/api/webhooks/${h.id}/deliveries/${d.id}/retry`, "POST", undefined, w.failed);
                                          setOpen(null);
                                        })
                                      }
                                    >
                                      {w.actions.retry}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card p-5">
        <h2 className="card-title mb-2">{w.verifyTitle}</h2>
        <pre className="overflow-x-auto rounded-md bg-panel2 p-3 text-xs text-fg2">{VERIFY}</pre>
      </section>
    </div>
  );
}
