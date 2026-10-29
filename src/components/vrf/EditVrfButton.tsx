"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import type { VrfRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { VrfForm } from "./VrfForm";

/** Bouton « Modifier » de la page de détail d'une VRF. */
export function EditVrfButton({ vrf }: { vrf: VrfRow }) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)} aria-label={format(t.vrf.editLabel, { name: vrf.name })}>
        <Pencil className="h-4 w-4" />
        {t.vrf.edit}
      </button>
      {open && <VrfForm vrf={vrf} onClose={() => setOpen(false)} onCreated={() => router.refresh()} />}
    </>
  );
}
