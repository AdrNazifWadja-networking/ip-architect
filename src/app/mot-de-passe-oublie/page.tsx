import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { isResetAvailable } from "@/lib/db/passwordreset";
import { currentUser } from "@/lib/auth/guard";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const dynamic = "force-dynamic";

/** Page publique. Déjà connecté, ou connexion non activée (application ouverte) : retour à l'accueil. */
export default function ForgotPasswordPage() {
  if (!authEnabled(getDb()) || currentUser()) redirect("/");
  return <ForgotPasswordForm available={isResetAvailable()} />;
}
