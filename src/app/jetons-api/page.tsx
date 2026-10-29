import { currentUser, requireUser } from "@/lib/auth/guard";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { listTokens } from "@/lib/db/tokens";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { ApiTokensView } from "@/components/tokens/ApiTokensView";

export const dynamic = "force-dynamic";

export default function ApiTokensPage() {
  requireUser("viewer", { projectless: true });
  const user = currentUser();
  const { t } = getDictionary();
  // sans compte, un jeton n'aurait pas de propriétaire : la page l'explique au lieu de proposer un formulaire inutile
  const enabled = authEnabled(getDb()) && user !== null;
  return (
    <>
      <PageHeader title={t.tokens.title} subtitle={t.tokens.subtitle} />
      <ApiTokensView
        enabled={enabled}
        role={user?.role ?? "viewer"}
        initial={enabled ? listTokens(undefined, { userId: user!.id }) : []}
      />
    </>
  );
}
