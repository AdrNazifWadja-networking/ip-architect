import { notFound } from "next/navigation";
import { currentUser, requireUser } from "@/lib/auth/guard";
import { isTeacher, studentDetail, teacherDetail } from "@/lib/db/tp";
import { getDictionary } from "@/lib/i18n/server";
import { ApiError } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { TpStudentPanel } from "@/components/tp/TpStudentPanel";
import { TpTeacherView } from "@/components/tp/TpTeacherView";
import { listClasses } from "@/lib/db/tpclasses";

export const dynamic = "force-dynamic";

export default async function ExercisePage(props: { params: Promise<{ id: string }> }) {
  requireUser("viewer", { projectless: true });
  const params = await props.params;
  const user = currentUser();
  const { t } = getDictionary();
  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();
  try {
    if (isTeacher(user)) {
      // l'enseignant voit aussi l'exercice comme un étudiant (aperçu)
      const teacher = teacherDetail(id, user);
      return (
        <>
          <PageHeader title={teacher.exercise.title} subtitle={t.tp.kinds[teacher.exercise.kind]} />
          <TpTeacherView teacher={teacher} preview={studentDetail(id, user)} classes={listClasses().map((c) => ({ id: c.id, name: c.name }))} />
        </>
      );
    }
    const detail = studentDetail(id, user);
    return (
      <>
        <PageHeader title={detail.exercise.title} subtitle={t.tp.kinds[detail.exercise.kind]} />
        <TpStudentPanel detail={detail} />
      </>
    );
  } catch (e) {
    // un brouillon est « introuvable » pour un étudiant (on ne révèle pas son existence)
    if (e instanceof ApiError && e.code === "tpNotFound") notFound();
    throw e;
  }
}
