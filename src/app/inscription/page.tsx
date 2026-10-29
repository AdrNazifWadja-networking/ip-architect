import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { getSignupConfig, isSignupOpen } from "@/lib/db/signupsettings";
import { currentUser } from "@/lib/auth/guard";
import { SignupForm } from "@/components/auth/SignupForm";

export const dynamic = "force-dynamic";

/** Page publique. Déjà connecté, ou connexion non activée (application ouverte) : retour à l'accueil. */
export default function InscriptionPage() {
  if (!authEnabled(getDb()) || currentUser()) redirect("/");
  return <SignupForm open={isSignupOpen()} domains={isSignupOpen() ? getSignupConfig().domains : []} />;
}
