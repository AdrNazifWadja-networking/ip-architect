"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import type { DhcpScopeRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { ScopeForm } from "./ScopeForm";

/** Bouton « Modifier » de la page de détail d'une plage. */
export function EditScopeButton({ scope }: { scope: DhcpScopeRow }) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)} aria-label={format(t.dhcp.editLabel, { name: scope.name })}>
        <Pencil className="h-4 w-4" />
        {t.dhcp.edit}
      </button>
      {open && (
        <ScopeForm
          scope={scope}
          networks={[]}
          initialNetworkId={null}
          onClose={() => setOpen(false)}
          onCreated={() => router.refresh()}
        />
      )}
    </>
  );
}
