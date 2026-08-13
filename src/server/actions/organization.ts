"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { locations, organizationMembers, organizations, units } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_UNITS } from "@/lib/units";
import { slugify } from "@/lib/utils";
import { locationInput, onboardingInput, organizationSettingsInput, unitInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { requirePermission, requireTenant } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

const TIMEZONE_BY_LOCALE: Record<string, string> = { "fr-TN": "Africa/Tunis", "ar-TN": "Africa/Tunis", "fr-FR": "Europe/Paris", "en-US": "America/New_York" };

/**
 * Creates the organization, its first location, the owner membership and the
 * standard unit table in a single transaction. This is the only write in the
 * app that runs before a tenant context exists.
 */
export async function createWorkspace(_prev: unknown, formData: FormData): Promise<ActionResult<{ organizationId: string }>> {
  try {
    const input = onboardingInput.parse(Object.fromEntries(formData));

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return actionError("Your session expired. Sign in again.");

    const db = getDb();

    const existing = await db.select({ organizationId: organizationMembers.organizationId }).from(organizationMembers).where(eq(organizationMembers.userId, user.id)).limit(1);
    if (existing.length) return actionOk({ organizationId: existing[0].organizationId });

    const organizationId = await db.transaction(async tx => {
      const slug = `${slugify(input.organizationName) || "workspace"}-${crypto.randomUUID().slice(0, 6)}`;
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: input.organizationName,
          slug,
          currency: input.currency,
          locale: input.locale,
          timezone: input.timezone ?? TIMEZONE_BY_LOCALE[input.locale] ?? "Africa/Tunis",
        })
        .returning();

      const [location] = await tx.insert(locations).values({ organizationId: organization.id, name: input.locationName }).returning();
      await tx.insert(organizationMembers).values({ organizationId: organization.id, userId: user.id, role: "owner", defaultLocationId: location.id });
      await tx.insert(units).values(DEFAULT_UNITS.map(unit => ({ ...unit, organizationId: organization.id })));

      await recordAudit(
        { organizationId: organization.id, userId: user.id, action: "create", entityType: "organization", entityId: organization.id, metadata: { name: organization.name } },
        tx,
      );
      return organization.id;
    });

    revalidatePath("/", "layout");
    return actionOk({ organizationId });
  } catch (error) {
    return toActionError(error);
  }
}

/** Marks the guided setup as done so `/dashboard` stops redirecting to the wizard. */
export async function completeSetup(): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_settings");
    if (tenant.onboardingCompletedAt) return actionOk();

    await getDb().transaction(async tx => {
      await tx.update(organizations).set({ onboardingCompletedAt: new Date(), updatedAt: new Date() }).where(eq(organizations.id, tenant.organizationId));
      await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "complete_setup", entityType: "organization", entityId: tenant.organizationId }, tx);
    });

    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/** Re-opens the checklist from Settings. */
export async function reopenSetup(): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_settings");
    await getDb().transaction(async tx => {
      await tx.update(organizations).set({ onboardingCompletedAt: null, updatedAt: new Date() }).where(eq(organizations.id, tenant.organizationId));
      await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "reopen_setup", entityType: "organization", entityId: tenant.organizationId }, tx);
    });
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateOrganization(_prev: unknown, formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_settings");
    const input = organizationSettingsInput.parse(Object.fromEntries(formData));

    await getDb().transaction(async tx => {
      await tx
        .update(organizations)
        .set({ name: input.name, currency: input.currency, locale: input.locale, timezone: input.timezone, updatedAt: new Date() })
        .where(eq(organizations.id, tenant.organizationId));
      await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "update", entityType: "organization", entityId: tenant.organizationId }, tx);
    });
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function saveLocation(_prev: unknown, formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_settings");
    const raw = Object.fromEntries(formData);
    const input = locationInput.parse({ ...raw, isActive: raw.isActive === undefined ? true : raw.isActive === "on" || raw.isActive === "true" });

    await getDb().transaction(async tx => {
      let savedId = input.id ?? null;
      if (input.id) {
        const [updated] = await tx
          .update(locations)
          .set({ name: input.name, address: input.address ?? null, isActive: input.isActive, updatedAt: new Date() })
          .where(and(eq(locations.id, input.id), eq(locations.organizationId, tenant.organizationId)))
          .returning({ id: locations.id });
        if (!updated) throw new ActionError("Location not found.");
      } else {
        const [created] = await tx
          .insert(locations)
          .values({ organizationId: tenant.organizationId, name: input.name, address: input.address ?? null, isActive: input.isActive })
          .returning({ id: locations.id });
        savedId = created.id;
      }

      await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: input.id ? "update" : "create", entityType: "location", entityId: savedId }, tx);
    });
    revalidatePath("/dashboard/settings");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function saveUnit(_prev: unknown, formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_settings");
    const input = unitInput.parse(Object.fromEntries(formData));
    await getDb().transaction(async tx => {
      let unitId = input.id ?? null;
      if (input.id) {
        const [updated] = await tx
          .update(units)
          .set({ code: input.code, name: input.name, dimension: input.dimension, multiplierToBase: String(input.multiplierToBase) })
          .where(and(eq(units.id, input.id), eq(units.organizationId, tenant.organizationId)))
          .returning({ id: units.id });
        if (!updated) throw new ActionError("Unit not found.");
      } else {
        const [created] = await tx.insert(units).values({
          organizationId: tenant.organizationId,
          code: input.code,
          name: input.name,
          dimension: input.dimension,
          multiplierToBase: String(input.multiplierToBase),
          isBase: input.multiplierToBase === 1,
        }).returning({ id: units.id });
        unitId = created.id;
      }

      await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: input.id ? "update" : "create", entityType: "unit", entityId: unitId, metadata: { code: input.code } }, tx);
    });
    revalidatePath("/dashboard/settings");
    revalidatePath("/dashboard/ingredients");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Removes a unit of measure.
 *
 * Audited inside the transaction: every quantity conversion in the app resolves
 * through this table, so losing a unit silently changes how purchases, recipes
 * and counts are interpreted. The code is captured before the delete because
 * afterwards there is nothing left to name in the record.
 */
export async function deleteUnit(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_settings");

    await getDb().transaction(async tx => {
      const [deleted] = await tx
        .delete(units)
        .where(and(eq(units.id, id), eq(units.organizationId, tenant.organizationId)))
        .returning({ code: units.code, name: units.name });
      if (!deleted) throw new ActionError("Unit not found.");

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "delete",
          entityType: "unit",
          entityId: id,
          metadata: { code: deleted.code, name: deleted.name },
        },
        tx,
      );
    });

    revalidatePath("/dashboard/settings");
    revalidatePath("/dashboard/ingredients");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
