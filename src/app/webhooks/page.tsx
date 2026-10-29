import { requireUser } from "@/lib/auth/guard";
import { listWebhooks } from "@/lib/db/webhooks";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { WebhooksView } from "@/components/webhooks/WebhooksView";

export const dynamic = "force-dynamic";

/** Webhooks du projet actif : administrateur. */
export default function WebhooksPage() {
  requireUser("admin");
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.webhooks.title} subtitle={t.webhooks.subtitle} />
      <WebhooksView webhooks={listWebhooks()} />
    </>
  );
}
