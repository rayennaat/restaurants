"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { createWorkspace } from "@/server/actions/organization";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button className="w-full" disabled={pending}>
      {pending ? "Creating your workspace…" : "Create workspace"}
    </Button>
  );
}

/**
 * First screen for a signed-in user with no organization. Posts to the
 * `createWorkspace` server action, which provisions the org, its first
 * location, the owner membership and the standard units in one transaction.
 *
 * `pendingInvitations` names any workspaces that have invited this address.
 * Creating a new workspace while one is outstanding is allowed but rarely
 * intended — the oldest membership wins when resolving the tenant, so an
 * employee who does both would keep landing in their own empty organization.
 */
export function WorkspaceCreation({ pendingInvitations = [] }: { pendingInvitations?: string[] }) {
  const router = useRouter();
  const [state, formAction] = useActionState(createWorkspace, null);

  useEffect(() => {
    if (state?.ok) {
      // Land on the guided checklist, which the onboarding route now serves.
      router.replace("/onboarding");
      router.refresh();
    }
  }, [state, router]);

  return (
    <main className="grid min-h-screen place-items-center p-5 grid-bg">
      <div className="w-full max-w-lg rounded-3xl border bg-white p-8 panel-shadow">
        <span className="grid size-12 place-items-center rounded-2xl bg-green-800 text-white">
          <Store size={24} />
        </span>

        <p className="mt-6 text-xs font-black uppercase tracking-[.2em] text-green-700">One-minute setup</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Create your restaurant workspace</h1>
        <p className="mb-7 mt-2 text-[var(--muted)]">
          We will create your organization, first location and standard units. You can add more locations and change any of this later in Settings.
        </p>

        {pendingInvitations.length > 0 && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
            <p className="text-sm font-bold text-amber-900">
              You have been invited to {pendingInvitations.join(", ")}
            </p>
            <p className="mt-1 text-sm text-amber-900/80">
              To join as an employee, open the invitation link that was shared with you instead of creating a new
              workspace. Creating one here makes a separate, empty restaurant that only you can see.
            </p>
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <Field label="Restaurant or group name" required>
            <Input name="organizationName" required placeholder="Example: BIG MO" autoFocus />
          </Field>

          <Field label="First location" required hint="Stock, purchases and waste are all tracked per location.">
            <Input name="locationName" required placeholder="Example: La Marsa" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Currency" required>
              <Select name="currency" defaultValue="TND">
                {SUPPORTED_CURRENCIES.map(currency => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Language" required>
              <Select name="locale" defaultValue="fr-TN">
                <option value="fr-TN">French (Tunisia)</option>
                <option value="ar-TN">Arabic (Tunisia)</option>
                <option value="fr-FR">French (France)</option>
                <option value="en-US">English (US)</option>
              </Select>
            </Field>
          </div>

          {state && !state.ok && <FormError message={state.error} />}

          <SubmitButton />
        </form>
      </div>
    </main>
  );
}
