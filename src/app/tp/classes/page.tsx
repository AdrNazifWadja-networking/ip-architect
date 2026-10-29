import { requireUser } from "@/lib/auth/guard";
import { listClasses, listStudents } from "@/lib/db/tpclasses";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { ClassesView } from "@/components/tp/ClassesView";

export const dynamic = "force-dynamic";

/** Classes du mode TP : enseignant (éditeur ou plus). */
export default function TpClassesPage() {
  requireUser("editor", { projectless: true });
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.tp.classes.title} subtitle={t.tp.subtitle} />
      <ClassesView classes={listClasses()} students={listStudents()} />
    </>
  );
}
