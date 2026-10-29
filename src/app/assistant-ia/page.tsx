import { currentUser, requireUser } from "@/lib/auth/guard";
import { getAiConfig } from "@/lib/db/aisettings";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { AssistantView } from "@/components/assistant/AssistantView";

export const dynamic = "force-dynamic";

export default function AssistantPage() {
  requireUser(); // première instruction : exigé par auth.test.ts
  const user = currentUser();
  const { t } = getDictionary();
  // application ouverte (aucun compte) = tout le monde est administrateur
  const isAdmin = user === null || user.role === "admin";
  return (
    <>
      <PageHeader title={t.assistant.title} subtitle={t.assistant.subtitle} />
      <AssistantView initialConfig={getAiConfig()} isAdmin={isAdmin} />
    </>
  );
}
