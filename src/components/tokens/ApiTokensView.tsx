"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { TOKEN_EXPIRY_CHOICES, TOKEN_NAME_MAX, TOKEN_ROLES, type ApiTokenRow, type TokenRole } from "@/lib/tokenTypes";
import type { UserRole } from "@/lib/types";

interface Props {
  enabled: boolean;
  role: UserRole;
  initial: ApiTokenRow[];
}

const EXPIRY_KEY: Record<number, "d30" | "d90" | "d365" | "never"> = { 30: "d30", 90: "d90", 365: "d365", 0: "never" };
const STATUS_TONE = { active: "bg-ok/15 text-ok", expired: "bg-warn/15 text-warn", revoked: "bg-bad/15 text-bad" } as const;

export function ApiTokensView({ enabled, role, initial }: Props) {
  const { t, locale } = useI18n();
  const k = t.tokens;
  const [tokens, setTokens] = useState<ApiTokenRow[]>(initial);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState("");
  const [tokenRole, setTokenRole] = useState<TokenRole>("viewer");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!enabled) {
    return (
      <div className="card px-6 py-12 text-center text-sm text-muted" role="status">
        {k.openMode}
      </div>
    );
  }

  const when = (iso: string | null, empty: string) => (iso ? new Date(iso).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) : empty);
  // un lecteur ne peut créer que des jetons « lecture seule »
  const roles = TOKEN_ROLES.filter((r) => r === "viewer" || role !== "viewer");

  const reload = async (all: boolean) => {
    const res = await fetch(`/api/tokens${all ? "?all=1" : ""}`);
    const data = (await res.json().catch(() => ({}))) as { tokens?: ApiTokenRow[]; error?: string };
    if (!res.ok || !data.tokens) throw new Error(data.error ?? t.errors.internal);
    setTokens(data.tokens);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, role: tokenRole, expiresInDays: days }) });
      const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !data.token) throw new Error(data.error ?? t.errors.internal);
      setCreated(data.token);
      setCopied(false);
      setName("");
      await reload(showAll);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.internal);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: ApiTokenRow) => {
    if (!window.confirm(format(k.list.confirm, { name: row.name }))) return;
    setError(null);
    try {
      const res = await fetch(`/api/tokens/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t.errors.internal);
      }
      await reload(showAll);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.internal);
    }
  };

  const toggleAll = async (all: boolean) => {
    setShowAll(all);
    setError(null);
    try {
      await reload(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.internal);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      /* presse-papiers indisponible : le jeton reste sélectionnable à l'écran */
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const label = "mb-1 block text-xs font-medium text-fg2";

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg2">{k.intro}</p>

      {created && (
        <section className="card border-warn/40 bg-warn/10 p-4" aria-labelledby="tok-created">
          <h2 id="tok-created" className="card-title">{k.created.title}</h2>
          <p className="mt-1 text-sm text-fg2">{k.created.warning}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-panel px-3 py-2 font-mono text-[12.5px] text-fg">{created}</code>
            <button type="button" className="btn-ghost" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? k.created.copied : k.created.copy}
            </button>
          </div>
          <p className="label-caps mt-4">{k.created.usage}</p>
          <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-panel p-3 font-mono text-[12px] text-fg">{`curl -H "Authorization: Bearer ${created}" ${origin}/api/networks`}</pre>
          <button type="button" className="btn-primary mt-3" onClick={() => setCreated(null)}>{k.created.dismiss}</button>
        </section>
      )}

      <form onSubmit={create} className="card grid gap-3 p-4 md:grid-cols-[2fr_1fr_1fr_auto]" aria-label={k.create.title}>
        <div>
          <label className={label} htmlFor="tok-name">{k.create.name}</label>
          <input id="tok-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={TOKEN_NAME_MAX} placeholder={k.create.namePlaceholder} required />
        </div>
        <div>
          <label className={label} htmlFor="tok-role">{k.create.role}</label>
          <select id="tok-role" className="input" value={tokenRole} onChange={(e) => setTokenRole(e.target.value as TokenRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>{k.create.roles[r]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="tok-days">{k.create.expiry}</label>
          <select id="tok-days" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {TOKEN_EXPIRY_CHOICES.map((d) => (
              <option key={d} value={d}>{k.create.expiryOptions[EXPIRY_KEY[d]]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full" disabled={busy || !name.trim()}>
            <Plus className="h-4 w-4" />
            {busy ? k.create.creating : k.create.submit}
          </button>
        </div>
      </form>
      <p className="-mt-3 text-xs text-muted">{k.roleNote}</p>

      {error && (
        <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      )}

      <section aria-labelledby="tok-list">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 id="tok-list" className="card-title">{showAll ? k.list.titleAll : k.list.title}</h2>
          <span className="text-sm text-muted">{format(k.list.count, { n: tokens.length })}</span>
          {role === "admin" && (
            <label className="ml-auto flex items-center gap-2 text-sm text-fg2">
              <input type="checkbox" checked={showAll} onChange={(e) => void toggleAll(e.target.checked)} />
              {k.list.showAll}
            </label>
          )}
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                <th className="px-4 py-3 font-medium">{k.list.columns.name}</th>
                <th className="px-4 py-3 font-medium">{k.list.columns.prefix}</th>
                <th className="px-4 py-3 font-medium">{k.list.columns.role}</th>
                {showAll && <th className="px-4 py-3 font-medium">{k.list.columns.owner}</th>}
                <th className="px-4 py-3 font-medium">{k.list.columns.created}</th>
                <th className="px-4 py-3 font-medium">{k.list.columns.lastUsed}</th>
                <th className="px-4 py-3 font-medium">{k.list.columns.expires}</th>
                <th className="px-4 py-3 font-medium">{k.list.columns.status}</th>
                <th className="px-4 py-3 text-right font-medium">{k.list.columns.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={showAll ? 9 : 8} className="px-4 py-10 text-center text-muted">{k.list.empty}</td>
                </tr>
              )}
              {tokens.map((r) => (
                <tr key={r.id} className="hover:bg-panel2/60">
                  <td className="px-4 py-2.5 font-medium text-fg">{r.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{r.prefix}…</td>
                  <td className="px-4 py-2.5 text-fg2">{k.create.roles[r.role]}</td>
                  {showAll && <td className="px-4 py-2.5 text-fg2">{r.username}</td>}
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{when(r.createdAt, "—")}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{when(r.lastUsedAt, k.list.never)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{when(r.expiresAt, k.list.noExpiry)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[r.status]}`}>{k.list.status[r.status]}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.status !== "revoked" && (
                      <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={() => void revoke(r)} aria-label={format(k.list.revokeLabel, { name: r.name })}>
                        <Trash2 className="h-3.5 w-3.5" />
                        {k.list.revoke}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="flex flex-wrap gap-4 text-sm">
        <a className="text-brand-soft hover:underline" href="/api/openapi" target="_blank" rel="noreferrer">{k.links.openapi}</a>
        <Link className="text-brand-soft hover:underline" href="/documentation#api">{k.links.docs}</Link>
      </p>
    </div>
  );
}
