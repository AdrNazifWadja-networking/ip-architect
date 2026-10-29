"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LdapConfig, OidcConfig, SsoConfig } from "@/lib/ssoTypes";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

async function call<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data;
}

const lines = (v: string): string[] => v.split("\n").map((x) => x.trim()).filter(Boolean);

type Prov = Pick<OidcConfig, "allowedGroups" | "adminGroups" | "editorGroups" | "defaultRole" | "syncRole">;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label-caps mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Roles({ p, set }: { p: Prov; set: (v: Prov) => void }) {
  const { t } = useI18n();
  const s = t.sso;
  const area = (key: "allowedGroups" | "adminGroups" | "editorGroups", label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <textarea className="input min-h-[72px] font-mono text-xs" value={p[key].join("\n")} onChange={(e) => set({ ...p, [key]: lines(e.target.value) })} />
    </Field>
  );
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="text-sm font-semibold text-fg">{s.rolesTitle}</div>
      <div className="grid gap-3 md:grid-cols-3">
        {area("allowedGroups", s.allowedGroups, s.allowedGroupsHint)}
        {area("adminGroups", s.adminGroups)}
        {area("editorGroups", s.editorGroups)}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Field label={s.defaultRole}>
          <select className="input" value={p.defaultRole} onChange={(e) => set({ ...p, defaultRole: e.target.value as Prov["defaultRole"] })}>
            <option value="viewer">{t.users.roles.viewer}</option>
            <option value="editor">{t.users.roles.editor}</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.syncRole} onChange={(e) => set({ ...p, syncRole: e.target.checked })} />
          {s.syncRole}
        </label>
      </div>
    </div>
  );
}

export function SsoSettings({ config }: { config: SsoConfig }) {
  const router = useRouter();
  const { t } = useI18n();
  const s = t.sso;
  const [oidc, setOidc] = useState<OidcConfig>(config.oidc);
  const [ldap, setLdap] = useState<LdapConfig>(config.ldap);
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [testUser, setTestUser] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      setInfo(await fn());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : s.failed);
    } finally {
      setBusy(false);
    }
  };

  const saveOidc = () =>
    run(async () => {
      const { hasSecret: _h, ...rest } = oidc;
      await call("/api/settings/sso", "PATCH", { oidc: { ...rest, ...(secret ? { clientSecret: secret } : {}) } }, s.failed);
      setSecret("");
      return s.saved;
    });
  const saveLdap = () =>
    run(async () => {
      const { hasPassword: _h, ...rest } = ldap;
      await call("/api/settings/sso", "PATCH", { ldap: { ...rest, ...(password ? { bindPassword: password } : {}) } }, s.failed);
      setPassword("");
      return s.saved;
    });
  const testOidc = () => run(async () => (await call("/api/settings/sso/test", "POST", { kind: "oidc" }, s.failed), s.testOidcOk));
  const testLdap = () =>
    run(async () => {
      const r = await call<{ count: number | null }>("/api/settings/sso/test", "POST", { kind: "ldap", username: testUser }, s.failed);
      return r.count === null ? s.testLdapOk : `${s.testLdapOk} — ${format(s.testUserFound, { count: String(r.count) })}`;
    });

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const callback = `${oidc.publicUrl || origin}/api/auth/oidc/callback`;
  const text = (v: string, set: (x: string) => void, extra: Record<string, unknown> = {}) => <input className="input" value={v} onChange={(e) => set(e.target.value)} {...extra} />;

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{s.intro}</p>
      {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
      {info && <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">{info}</div>}

      <section className="card space-y-4 p-5" aria-label={s.oidcTitle}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-fg">{s.oidcTitle}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={oidc.enabled} onChange={(e) => setOidc({ ...oidc, enabled: e.target.checked })} />
            {s.enabled}
          </label>
        </div>
        <Field label={s.callbackUrl}>
          <code className="block break-all rounded bg-surface-2 px-2 py-1.5 text-xs">{callback}</code>
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={s.issuer} hint={s.issuerHint}>{text(oidc.issuer, (v) => setOidc({ ...oidc, issuer: v }), { placeholder: "https://sso.exemple.fr/realms/entreprise" })}</Field>
          <Field label={s.clientId}>{text(oidc.clientId, (v) => setOidc({ ...oidc, clientId: v }), { autoComplete: "off" })}</Field>
          <Field label={s.clientSecret} hint={oidc.hasSecret ? s.secretSaved : undefined}>
            <input className="input" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
          <Field label={s.scopes}>{text(oidc.scopes, (v) => setOidc({ ...oidc, scopes: v }))}</Field>
          <Field label={s.usernameClaim}>{text(oidc.usernameClaim, (v) => setOidc({ ...oidc, usernameClaim: v }))}</Field>
          <Field label={s.groupsClaim} hint={s.groupsClaimHint}>{text(oidc.groupsClaim, (v) => setOidc({ ...oidc, groupsClaim: v }))}</Field>
          <Field label={s.label}>{text(oidc.label, (v) => setOidc({ ...oidc, label: v }))}</Field>
          <Field label={s.publicUrl} hint={s.publicUrlHint}>{text(oidc.publicUrl, (v) => setOidc({ ...oidc, publicUrl: v }))}</Field>
        </div>
        <Field label={s.domains} hint={s.domainsHint}>
          <textarea className="input min-h-[56px] font-mono text-xs" value={oidc.domains.join("\n")} onChange={(e) => setOidc({ ...oidc, domains: lines(e.target.value) })} />
        </Field>
        <Roles p={oidc} set={(p) => setOidc({ ...oidc, ...p })} />
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy} onClick={saveOidc}>{busy ? s.saving : s.save}</button>
          <button className="btn-secondary" disabled={busy} onClick={testOidc}>{busy ? s.testing : s.test}</button>
        </div>
      </section>

      <section className="card space-y-4 p-5" aria-label={s.ldapTitle}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-fg">{s.ldapTitle}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ldap.enabled} onChange={(e) => setLdap({ ...ldap, enabled: e.target.checked })} />
            {s.enabled}
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={s.url} hint={s.urlHint}>{text(ldap.url, (v) => setLdap({ ...ldap, url: v }), { placeholder: "ldaps://annuaire.exemple.fr" })}</Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={ldap.startTls} onChange={(e) => setLdap({ ...ldap, startTls: e.target.checked })} />
            {s.startTls}
          </label>
          <Field label={s.bindDn} hint={s.bindDnHint}>{text(ldap.bindDn, (v) => setLdap({ ...ldap, bindDn: v }), { autoComplete: "off" })}</Field>
          <Field label={s.bindPassword} hint={ldap.hasPassword ? s.passwordSaved : undefined}>
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label={s.baseDn}>{text(ldap.baseDn, (v) => setLdap({ ...ldap, baseDn: v }), { placeholder: "ou=people,dc=exemple,dc=fr" })}</Field>
          <Field label={s.userFilter} hint={s.userFilterHint}>{text(ldap.userFilter, (v) => setLdap({ ...ldap, userFilter: v }))}</Field>
          <Field label={s.usernameAttr}>{text(ldap.usernameAttr, (v) => setLdap({ ...ldap, usernameAttr: v }))}</Field>
          <Field label={s.displayNameAttr}>{text(ldap.displayNameAttr, (v) => setLdap({ ...ldap, displayNameAttr: v }))}</Field>
          <Field label={s.emailAttr}>{text(ldap.emailAttr, (v) => setLdap({ ...ldap, emailAttr: v }))}</Field>
          <Field label={s.groupAttr}>{text(ldap.groupAttr, (v) => setLdap({ ...ldap, groupAttr: v }))}</Field>
        </div>
        <Roles p={ldap} set={(p) => setLdap({ ...ldap, ...p })} />
        <div className="flex flex-wrap items-end gap-2">
          <button className="btn-primary" disabled={busy} onClick={saveLdap}>{busy ? s.saving : s.save}</button>
          <Field label={s.testUser}>{text(testUser, setTestUser)}</Field>
          <button className="btn-secondary" disabled={busy} onClick={testLdap}>{busy ? s.testing : s.test}</button>
        </div>
      </section>
    </div>
  );
}
