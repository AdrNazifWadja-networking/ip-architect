import { currentUser } from "@/lib/auth/guard";
import { getDemoInfo } from "@/lib/db/demo";
import { DemoBanner } from "./DemoBanner";

/** Bandeau de la démonstration : seulement pour un administrateur (ou sans compte), et tant que le projet de démonstration existe. */
export function DemoNotice() {
  const user = currentUser();
  if (user && user.role !== "admin") return null;
  const demo = getDemoInfo();
  if (!demo) return null;
  return <DemoBanner name={demo.name} networks={demo.networks} sites={demo.sites} vlans={demo.vlans} vrfs={demo.vrfs} />;
}
