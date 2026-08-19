"use client";

import { useActionState, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Plus, Store, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { createWorkspace } from "@/server/actions/organization";

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button className="w-full" disabled={pending || disabled}>
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
  const [locations, setLocations] = useState<string[]>([]);
  const [locationDraft, setLocationDraft] = useState("");
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    if (state?.ok) {
      // Land on the guided checklist, which the onboarding route now serves.
      router.replace("/onboarding");
      router.refresh();
    }
  }, [state, router]);

  const addLocation = () => {
    const name = locationDraft.trim();
    if (!name) {
      setLocationError("Enter a location name first.");
      return;
    }
    if (name.length > 120) {
      setLocationError("Location names must be 120 characters or fewer.");
      return;
    }
    if (locations.length >= 50) {
      setLocationError("You can add up to 50 locations.");
      return;
    }
    if (locations.some(location => location.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setLocationError("That location is already in the list.");
      return;
    }

    setLocations(current => [...current, name]);
    setLocationDraft("");
    setLocationError(null);
  };

  const handleLocationKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addLocation();
  };

  const removeLocation = (index: number) => {
    setLocations(current => current.filter((_, locationIndex) => locationIndex !== index));
    setLocationError(null);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const pendingName = locationDraft.trim();
    const submittedLocations = pendingName ? [...locations, pendingName] : locations;
    const normalized = submittedLocations.map(location => location.toLocaleLowerCase());

    if (!submittedLocations.length) {
      event.preventDefault();
      setLocationError("Add at least one location.");
      return;
    }
    if (pendingName.length > 120) {
      event.preventDefault();
      setLocationError("Location names must be 120 characters or fewer.");
      return;
    }
    if (submittedLocations.length > 50) {
      event.preventDefault();
      setLocationError("You can add up to 50 locations.");
      return;
    }
    if (new Set(normalized).size !== normalized.length) {
      event.preventDefault();
      setLocationError("Each location must be unique.");
      return;
    }

  };

  const pendingLocation = locationDraft.trim();
  const submittedLocations = pendingLocation ? [...locations, pendingLocation] : locations;
  const canSubmit = submittedLocations.length > 0;
  const serverLocationError = state?.ok === false ? state.fieldErrors?.locations : undefined;

  return (
    <main className="grid min-h-screen place-items-center p-5 grid-bg">
      <div className="w-full max-w-lg rounded-3xl border bg-white p-8 panel-shadow">
        <span className="grid size-12 place-items-center rounded-2xl bg-green-800 text-white">
          <Store size={24} />
        </span>

        <p className="mt-6 text-xs font-black uppercase tracking-[.2em] text-green-700">One-minute setup</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Create your restaurant workspace</h1>
        <p className="mb-7 mt-2 text-[var(--muted)]">
          We will create your organization, its locations and standard units. Add every branch you already operate; you can change them later in Settings.
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

        <form action={formAction} className="space-y-4" onSubmit={handleSubmit}>
          <Field label="Restaurant or group name" required>
            <Input name="organizationName" required placeholder="Example: BIG MO" autoFocus />
          </Field>

          <Field
            label="Locations"
            required
            error={locationError ?? serverLocationError}
            hint="Stock, purchases, sales and waste are tracked separately per location."
          >
            <input type="hidden" name="locations" value={JSON.stringify(submittedLocations)} readOnly />
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={locationDraft}
                onChange={event => {
                  setLocationDraft(event.target.value);
                  if (locationError) setLocationError(null);
                }}
                onKeyDown={handleLocationKeyDown}
                placeholder="Example: La Marsa"
                maxLength={120}
                autoComplete="off"
                aria-label="Location name"
                aria-invalid={Boolean(locationError ?? serverLocationError)}
                className="min-w-0"
              />
              <Button type="button" variant="secondary" onClick={addLocation} className="shrink-0" disabled={locations.length >= 50}>
                <Plus size={17} /> Add location
              </Button>
            </div>

            {locations.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2" aria-label="Added locations">
                {locations.map((location, index) => (
                  <span key={`${location}-${index}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-neutral-50 pl-3 pr-1.5 text-sm font-semibold">
                    {location}
                    {index === 0 && <span className="text-xs font-normal text-[var(--muted)]">Default</span>}
                    <button
                      type="button"
                      onClick={() => removeLocation(index)}
                      className="grid size-7 place-items-center rounded-md text-[var(--muted)] transition hover:bg-neutral-200 hover:text-[var(--foreground)]"
                      aria-label={`Remove ${location}`}
                      title={`Remove ${location}`}
                    >
                      <X size={15} />
                    </button>
                  </span>
                ))}
              </div>
            )}
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

          <SubmitButton disabled={!canSubmit} />
        </form>
      </div>
    </main>
  );
}
