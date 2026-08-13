"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { acceptInvitation } from "@/server/actions/team";

/**
 * The accept button on the invitation screen.
 *
 * Only the token is sent. The organization and the role come from the
 * invitation row on the server — there is no field here that could ask for a
 * different workspace or a higher role, because the server would ignore it.
 */
export function AcceptInvitation({ token, organizationName }: { token: string; organizationName: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const accept = () => {
    setError(null);
    startTransition(async () => {
      const result = await acceptInvitation(token);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    });
  };

  return (
    <div className="mt-6 space-y-3">
      <Button onClick={accept} disabled={pending} className="w-full">
        {pending ? "Joining…" : `Join ${organizationName}`}
      </Button>
      <FormError message={error} />
    </div>
  );
}
