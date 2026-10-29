"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { SessionUser, UserRole, UserRow } from "@/lib/types";
import { ROLES } from "@/lib/auth/roles";
import { format, INTL_TAG } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { UserForm } from "./UserForm";
import { AccountPanel } from "./AccountPanel";
import { SetupAuth } from "./SetupAuth";

interface Props {
  /** La connexion est-elle activée (au moins un compte) ? */
  enabled: boolean;
  /** Premier compte : le code d'installation affiché dans la console du serveur est exigé. */
  setupCodeRequired?: boolean;
  me: SessionUser | null;
  /** Vide pour un non-administrateur. */
  users: UserRow[];
  /** Projets existants (pour attribuer les accès). */
  projects: { id: number; name: string }[];
}

const ROLE_STYLE: Record<UserRole, string> = {
  admin: "bg-brand/15 text-brand-soft",
  editor: "bg-ok/15 text-ok",
  viewer: "bg-panel2 text-fg2",
};

export function UsersView({ enabled, setupCodeRequired, me, users, projects }: Props) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const u = t.users;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // date et heure en UTC : le serveur et le navigateur affichent la même chose
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(INTL_TAG[locale], { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) : u.list.never;

  if (!enabled) return <SetupAuth codeRequired={!!setupCodeRequired} />;

  const remove = async (user: UserRow) => {
    if (!window.confirm(format(u.list.deleteConfirm, { name: user.displayName }))) return;
    setBusy(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? u.list.deleteFailed);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : u.list.deleteFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <AccountPanel me={me} />

      {me?.role === "admin" && (
        <section aria-labelledby="users-list-title">
          <div className="mb-3 flex items-center">
            <h2 id="users-list-title" className="card-title">
              {u.list.title}
            </h2>
            <button className="btn-primary ml-auto" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              {u.list.newUser}
            </button>
          </div>

          {error && (
            <div role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          <div className="card overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-3 font-medium">{u.list.columns.username}</th>
                  <th className="px-4 py-3 font-medium">{u.list.columns.name}</th>
                  <th className="px-4 py-3 font-medium">{u.list.columns.email}</th>
                  <th className="px-4 py-3 font-medium">{u.list.columns.role}</th>
                  <th className="px-4 py-3 font-medium">{u.list.columns.access}</th>
                  <th className="px-4 py-3 font-medium">{u.list.columns.state}</th>
                  <th className="px-4 py-3 font-medium">{u.list.columns.lastLogin}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((user) => {
                  const self = me?.id === user.id;
                  return (
                    <tr key={user.id} className="hover:bg-panel2/60">
                      <td className="px-4 py-3 font-mono text-[13px] text-fg">
                        {user.username}
                        {self && <span className="ml-2 rounded-full bg-panel2 px-2 py-0.5 font-sans text-[11px] text-muted">{u.list.you}</span>}
                      </td>
                      <td className="px-4 py-3 text-fg2">
                        {user.displayName}
                        {user.authSource !== "local" && <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">{user.authSource === "ldap" ? "LDAP" : "SSO"}</span>}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-muted">
                        {user.email ? (
                          <span title={user.emailVerified ? "✓" : undefined}>
                            {user.email}
                            {user.emailVerified ? " ✓" : ""}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${ROLE_STYLE[user.role]}`}>{u.roles[user.role]}</span>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-muted">
                        {user.role === "admin" || user.projectScope === "all"
                          ? u.list.accessAll
                          : user.memberships.length === 0
                            ? u.list.accessNone
                            : format(u.list.accessSome, { n: user.memberships.length })}
                      </td>
                      <td className={`px-4 py-3 ${user.active ? "text-ok" : "text-muted"}`}>{user.active ? u.list.active : u.list.inactive}</td>
                      <td className="px-4 py-3 text-muted">{when(user.lastLoginAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setEditing(user)}
                            aria-label={format(u.list.editLabel, { name: user.displayName })}
                            className="rounded-md p-2 text-muted hover:bg-panel2 hover:text-fg"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => remove(user)}
                            disabled={busy === user.id || self}
                            aria-label={format(u.list.deleteLabel, { name: user.displayName })}
                            title={self ? t.errors.cannotChangeSelf : undefined}
                            className="rounded-md p-2 text-muted hover:bg-bad/10 hover:text-bad disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">{format(u.list.count, { n: users.length })}</p>
          <ul className="mt-3 space-y-1 text-xs text-muted">
            {ROLES.map((r) => (
              <li key={r}>
                <span className="font-medium text-fg2">{u.roles[r]}</span> : {u.roleHelp[r]}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && <UserForm key={editing.id} user={editing} projects={projects} isSelf={me?.id === editing.id} onClose={() => setEditing(null)} onDone={() => router.refresh()} />}
      {open && <UserForm projects={projects} onClose={() => setOpen(false)} onDone={() => router.refresh()} />}
    </div>
  );
}
