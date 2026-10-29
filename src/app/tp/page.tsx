import { currentUser, requireUser } from "@/lib/auth/guard";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { isTeacher, listExercises } from "@/lib/db/tp";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { TpListView } from "@/components/tp/TpListView";

export const dynamic = "force-dynamic";

export default function TpPage() {
  requireUser("viewer", { projectless: true });
  const user = currentUser();
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.tp.title} subtitle={t.tp.subtitle} />
      <TpListView items={listExercises(user)} canManage={isTeacher(user)} openMode={!authEnabled(getDb())} />
    </>
  );
}
