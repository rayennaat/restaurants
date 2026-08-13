import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { TransferBuilder } from "@/components/transfers/transfer-builder";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Building2 } from "lucide-react";
import { resolveMemberLocation } from "@/server/queries/locations";
import { transferableIngredients } from "@/server/queries/transfers";
import { getOrganizationUnits, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "New transfer" };

/**
 * Building a transfer.
 *
 * The ingredient list carries each item's on-hand quantity **at the source
 * location**, so the person filling in quantities can see what is actually
 * there. Those figures are a warning only — the server re-checks availability
 * inside the transaction that writes the movements.
 *
 * A transfer needs two locations to exist, so a single-site workspace gets an
 * explanation rather than a form that cannot be completed.
 */
export default async function NewTransferPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const tenant = await requireTenant();
  if (!hasPermission(tenant.role, "record_operations")) {
    redirect("/dashboard/transfers");
  }

  const params = await searchParams;
  const location = await resolveMemberLocation(tenant, params.from);

  // Only locations this member may dispatch from. For a site-bound member that
  // is exactly one, which is what stops them routing stock out of a branch they
  // do not work at.
  const options = location.options;
  const sourceId = location.id ?? options[0]?.id ?? "";

  const [units, ingredients] = await Promise.all([
    getOrganizationUnits(tenant.organizationId),
    sourceId ? transferableIngredients(tenant.organizationId, sourceId) : Promise.resolve([]),
  ]);

  return (
    <>
      <Link
        href="/dashboard/transfers"
        className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-neutral-900"
      >
        <ArrowLeft size={15} /> Transfers
      </Link>

      <PageHeader
        eyebrow="Inventory"
        title="New transfer"
        description="Choose where the stock is going, add what is moving, then send it."
      />

      {options.length < 2 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="A transfer needs two locations"
            description={
              location.options.length <= 1 && tenant.role !== "owner"
                ? "You are assigned to one location, so there is nowhere to transfer to. Ask an owner or manager to move stock between sites."
                : "This workspace has a single location. Add another in settings, then stock can move between them."
            }
            action={tenant.role === "owner" ? { label: "Add a location", href: "/dashboard/settings" } : undefined}
          />
        </Card>
      ) : ingredients.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="No ingredients to transfer"
            description="Add ingredients and record some purchases first — a transfer can only move stock that exists."
            action={{ label: "Go to ingredients", href: "/dashboard/ingredients" }}
          />
        </Card>
      ) : (
        <TransferBuilder
          locations={options}
          ingredients={ingredients}
          units={units}
          currency={tenant.currency}
          defaultSourceId={sourceId}
        />
      )}
    </>
  );
}
