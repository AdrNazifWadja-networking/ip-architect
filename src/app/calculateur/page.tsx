import { requireUser } from "@/lib/auth/guard";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { IpCalculator } from "@/components/calculator/IpCalculator";

export const dynamic = "force-dynamic";

export default function CalculateurPage() {
  requireUser();
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.calculator.title} subtitle={t.calculator.subtitle} />
      <IpCalculator />
    </>
  );
}
