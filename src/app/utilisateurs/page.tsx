import { requireUser } from "@/lib/auth/guard";
import { setupActive } from "@/lib/auth/setup";
import { currentUser } from "@/lib/auth/guard";
import { getDb } from "@/lib/db";
import { authEnabled, listUsers } from "@/lib/db/users";
import { listProjects } from "@/lib/db/projects";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { UsersView } from "@/components/users/UsersView";

export const dynamic = "force-dynamic";

export default function UtilisateursPage() {
  const enabled = authEnabled(getDb());
  if (enabled) requireUser(); // sans compte, cette page est la seule accessible (création du premier administrateur)
  const { t } = getDictionary();
  const me = currentUser();
  // la liste des comptes n'est envoyée qu'aux administrateurs
  const users = me?.role === "admin" ? listUsers() : [];
  return (
    <>
      <PageHeader title={t.users.title} subtitle={t.users.subtitle} />
      <UsersView setupCodeRequired={!enabled && setupActive(getDb())} enabled={enabled} me={me} users={users} projects={me?.role === "admin" ? listProjects().map((p) => ({ id: p.id, name: p.name })) : []} />
    </>
  );
}
