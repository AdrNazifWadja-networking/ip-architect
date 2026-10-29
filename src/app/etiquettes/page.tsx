import { currentUser, requireUser } from "@/lib/auth/guard";
import { atLeast } from "@/lib/auth/roles";
import { listFields, listTags } from "@/lib/db/meta";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { MetaView } from "@/components/meta/MetaView";

export const dynamic = "force-dynamic";

export default function EtiquettesPage() {
  requireUser("viewer");
  const user = currentUser();
  const { t } = getDictionary();
  // application ouverte (aucun compte) : tout est permis, comme pour le reste de l'application
  const canEdit = user === null || atLeast(user.role, "editor");
  const canDefine = user === null || user.role === "admin";
  return (
    <>
      <PageHeader title={t.tagging.title} subtitle={t.tagging.subtitle} />
      <MetaView tags={listTags()} fields={listFields()} canEdit={canEdit} canDefine={canDefine} />
    </>
  );
}
