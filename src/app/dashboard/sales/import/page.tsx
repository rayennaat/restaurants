import Link from "next/link";
import { History, Plug, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { ImportWizard } from "@/components/sales/import-wizard";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { listMenuItems } from "@/server/queries/menu";
import { resolveMemberLocation } from "@/server/queries/locations";
import { getOrganizationUnits, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Import sales" };

/**
 * CSV / POS sales import.
 *
 * The write permission is checked here as well as in the action. Hiding the
 * screen is a courtesy — `commitSalesImport` re-checks `manage_sales`,
 * re-validates the file and re-resolves every menu item against the caller's own
 * organization, so this page cannot be the thing that authorizes an import.
 *
 * Locations are resolved through `resolveMemberLocation`, so a site-bound member
 * is offered only their own site and cannot import another branch's revenue.
 */
export default async function SalesImportPage() {
  const tenant = await requireTenant();
  const canImport = hasPermission(tenant.role, "manage_sales");

  const [units, location] = await Promise.all([
    getOrganizationUnits(tenant.organizationId),
    resolveMemberLocation(tenant, undefined),
  ]);

  const menuItems = canImport ? await listMenuItems(tenant.organizationId, units, { status: "all" }) : [];

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Import sales"
        description="Bring in sales exported from your till. Upload the file, tell us which column is which, check what we found, then import. Nothing is saved until you confirm."
        action={
          <Link
            href="/dashboard/sales/imports"
            className="inline-flex h-11 items-center gap-2 rounded-xl border bg-white px-4 font-semibold transition hover:bg-neutral-50"
          >
            <History size={16} /> Import history
          </Link>
        }
      />

      <SectionNav />

      {!canImport ? (
        <Card>
          <EmptyState
            icon={ShieldCheck}
            title="Your role cannot import sales"
            description="Importing revenue is limited to owners and managers. You can still view sales and every report built on them."
            action={{ label: "View sales", href: "/dashboard/sales" }}
          />
        </Card>
      ) : menuItems.length === 0 ? (
        <Card>
          <EmptyState
            icon={Plug}
            title="Add your menu first"
            description="An import matches the dish names in your file against your menu. Create your menu items and we will line them up for you."
            action={{ label: "Go to menu", href: "/dashboard/menu" }}
          />
        </Card>
      ) : location.options.length === 0 ? (
        <Card>
          <EmptyState
            icon={Plug}
            title="No location assigned"
            description="Sales are recorded against a location. Ask an owner or manager to assign you one."
            action={{ label: "Settings", href: "/dashboard/settings" }}
          />
        </Card>
      ) : (
        <>
          <ImportWizard
            locations={location.options}
            menuItems={menuItems.map(item => ({
              id: item.id,
              name: item.name,
              sellingPriceMillis: item.sellingPriceMillis,
            }))}
            currency={tenant.currency}
            defaultLocationId={location.id ?? location.options[0]?.id}
          />

          <Card className="mt-6 border-neutral-200 bg-neutral-50/60">
            <CardHeader>
              <h2 className="text-base font-black">How importing works</h2>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-2">
              <p>
                <b className="text-neutral-900">Your prices are kept.</b> Each line is stored at the price in your file,
                not today&apos;s menu price — so last year&apos;s revenue stays last year&apos;s revenue. If a row has no
                price we use the current menu price and flag it.
              </p>
              <p>
                <b className="text-neutral-900">Importing twice is safe.</b> Each sale gets a fingerprint from its own
                contents, so re-uploading the same file reports the rows as already imported instead of doubling your
                takings.
              </p>
              <p>
                <b className="text-neutral-900">Nothing is invented.</b> A dish we cannot match is never created
                automatically — you point it at an existing menu item, or the row is skipped.
              </p>
              <p>
                <b className="text-neutral-900">All or nothing.</b> An import either completes fully or leaves no trace.
                A failure part-way through cannot leave half your sales behind.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
