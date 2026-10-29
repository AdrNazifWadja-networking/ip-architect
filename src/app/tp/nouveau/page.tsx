import { requireUser } from "@/lib/auth/guard";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { TpForm } from "@/components/tp/TpForm";
import { listClasses } from "@/lib/db/tpclasses";

export const dynamic = "force-dynamic";

/** Création d'un exercice : enseignant (éditeur ou plus). */
export default function NewExercisePage() {
  requireUser("editor", { projectless: true });
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.tp.form.createTitle} subtitle={t.tp.subtitle} />
      <TpForm classes={listClasses().map((c) => ({ id: c.id, name: c.name }))} />
    </>
  );
}
