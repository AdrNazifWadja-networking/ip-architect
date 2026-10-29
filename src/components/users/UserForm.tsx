"use client";

import { useState } from "react";
import type { UserRole, UserRow } from "@/lib/types";
import type { MemberRole, ProjectScope } from "@/lib/projectAccess";
import { ROLES } from "@/lib/auth/roles";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/constants";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

interface Props {
  /** Présent = mode modification. */
  user?: UserRow;
  projects: { id: number; name: string }[];
  /** Le compte modifié est celui de l'administrateur connecté : rôle et état verrouillés. */
  isSelf?: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function UserForm({ user, projects, isSelf = false, onClose, onDone }: Props) {
  const { t } = useI18n();
  const f = t.users.form;
  const editing = user !== undefined;
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<UserRole>(user?.role ?? "viewer");
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState<ProjectScope>(user?.projectScope ?? "all");
  const [member, setMember] = useState<Record<number, "" | MemberRole>>(() => Object.fromEntries((user?.memberships ?? []).map((m) => [m.projectId, m.role])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // un administrateur voit toujours tous les projets
  const effScope: ProjectScope = role === "admin" ? "all" : scope;
  const memberships = projects.flatMap((p) => (member[p.id] ? [{ projectId: p.id, role: member[p.id] as MemberRole }] : []));
  const sameList = (a: { projectId: number; role: string }[], b: { projectId: number; role: string }[]) =>
    JSON.stringify([...a].sort((x, y) => x.projectId - y.projectId)) === JSON.stringify([...b].sort((x, y) => x.projectId - y.projectId));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // en modification, on n'envoie que ce qui change (le serveur refuse de toucher au rôle/à l'état de soi-même)
      const body = editing
        ? {
            ...(displayName !== user.displayName ? { displayName } : {}),
            ...(email.trim() !== (user.email ?? "") ? { email: email.trim() || null } : {}),
            ...(effScope === "all" && role !== user.role ? { role } : {}),
            ...(effScope !== user.projectScope ? { projectScope: effScope } : {}),
            ...(effScope === "selected" && !(user.projectScope === "selected" && sameList(memberships, user.memberships)) ? { memberships } : {}),
            ...(active !== user.active ? { active } : {}),
            ...(password ? { password } : {}),
          }
        : {
            username,
            displayName,
            role: effScope === "selected" ? "viewer" : role,
            password,
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(effScope === "selected" ? { projectScope: effScope, memberships } : {}),
          };
      if (editing && Object.keys(body).length === 0) {
        onClose();
        return;
      }
      const res = await fetch(editing ? `/api/users/${user.id}` : "/api/users", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; user?: { id: number } };
      if (!res.ok || !data.user) throw new Error(data.error ?? (editing ? f.saveFailed : f.createFailed));
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : editing ? f.saveFailed : f.createFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? f.editTitle : f.title} closeLabel={f.close} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="user-username">
            {f.username}
          </label>
          <input
            id="user-username"
            autoFocus={!editing}
            required
            disabled={editing}
            maxLength={40}
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input font-mono disabled:opacity-60"
          />
          {!editing && <p className="mt-1 text-[11px] text-muted">{f.usernameHint}</p>}
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="user-display">
            {f.displayName}
          </label>
          <input id="user-display" required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="user-email">
            {f.email}
          </label>
          <input id="user-email" type="email" maxLength={254} autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
          <p className="mt-1 text-[11px] text-muted">{f.emailHint}</p>
        </div>
        {effScope === "all" && (
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="user-role">
              {f.role}
            </label>
            <select id="user-role" value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as UserRole)} className="input disabled:opacity-60">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t.users.roles[r]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted">{t.users.roleHelp[role]}</p>
          </div>
        )}
        {role !== "admin" && !isSelf && (
          <fieldset className="space-y-2">
            <legend className="label-caps mb-1.5 block">{f.scope}</legend>
            <label className="flex items-start gap-2 text-sm text-fg2">
              <input type="radio" name="user-scope" className="mt-1" checked={scope === "all"} onChange={() => setScope("all")} />
              <span>
                {f.scopeAll}
                <span className="block text-[11px] text-muted">{f.scopeAllHelp}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-fg2">
              <input type="radio" name="user-scope" className="mt-1" checked={scope === "selected"} onChange={() => setScope("selected")} />
              <span>
                {f.scopeSelected}
                <span className="block text-[11px] text-muted">{f.scopeSelectedHelp}</span>
              </span>
            </label>
            {scope === "selected" && (
              <div className="rounded-md border border-line bg-panel2 p-3">
                {projects.length === 0 ? (
                  <p className="text-sm text-muted">{f.noProjects}</p>
                ) : (
                  <ul className="space-y-2">
                    {projects.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-3">
                        <label htmlFor={`pm-${p.id}`} className="min-w-0 flex-1 truncate text-sm text-fg">
                          {p.name}
                        </label>
                        <select
                          id={`pm-${p.id}`}
                          className="input w-44"
                          value={member[p.id] ?? ""}
                          onChange={(e) => setMember({ ...member, [p.id]: e.target.value as "" | MemberRole })}
                        >
                          <option value="">{f.noAccess}</option>
                          <option value="viewer">{t.users.roles.viewer}</option>
                          <option value="editor">{t.users.roles.editor}</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-muted">{f.scopeNote}</p>
              </div>
            )}
          </fieldset>
        )}
        <div>
          <label className="label-caps mb-1.5 block" htmlFor="user-password">
            {editing ? f.newPassword : f.password}
          </label>
          <input
            id="user-password"
            type="password"
            required={!editing}
            minLength={editing ? undefined : MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
          <p className="mt-1 text-[11px] text-muted">{editing ? f.newPasswordHint : format(f.passwordHint, { min: MIN_PASSWORD_LENGTH })}</p>
        </div>
        {editing && (
          <label className="flex items-center gap-2 text-sm text-fg2">
            <input type="checkbox" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
            {f.active}
          </label>
        )}
        {isSelf && <p className="text-[11px] text-muted">{f.selfNote}</p>}

        {error && (
          <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            {f.cancel}
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? (editing ? f.saving : f.submitting) : editing ? f.save : f.submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}
