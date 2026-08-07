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
import { assertCan, requireTenant } from "@/server/tenant";

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
    assertCan(tenant.role, "manage_settings");
    if (tenant.onboardingCompletedAt) return actionOk();

    await getDb().update(organizations).set({ onboardingCompletedAt: new Date(), updatedAt: new Date() }).where(eq(organizations.id, tenant.organizationId));
    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "complete_setup", entityType: "organization", entityId: tenant.organizationId });

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
    assertCan(tenant.role, "manage_settings");
    await getDb().update(organizations).set({ onboardingCompletedAt: null, updatedAt: new Date() }).where(eq(organizations.id, tenant.organizationId));
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateOrganization(_prev: unknown, formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_settings");
    const input = organizationSettingsInput.parse(Object.fromEntries(formData));

    await getDb()
      .update(organizations)
      .set({ name: input.name, currency: input.currency, locale: input.locale, timezone: input.timezone, updatedAt: new Date() })
      .where(eq(organizations.id, tenant.organizationId));

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "update", entityType: "organization", entityId: tenant.organizationId });
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function saveLocation(_prev: unknown, formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_settings");
    const raw = Object.fromEntries(formData);
    const input = locationInput.parse({ ...raw, isActive: raw.isActive === undefined ? true : raw.isActive === "on" || raw.isActive === "true" });

    const db = getDb();
    if (input.id) {
      await db
        .update(locations)
        .set({ name: input.name, address: input.address ?? null, isActive: input.isActive, updatedAt: new Date() })
        .where(and(eq(locations.id, input.id), eq(locations.organizationId, tenant.organizationId)));
    } else {
      await db.insert(locations).values({ organizationId: tenant.organizationId, name: input.name, address: input.address ?? null, isActive: input.isActive });
    }

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: input.id ? "update" : "create", entityType: "location", entityId: input.id ?? null });
    revalidatePath("/dashboard/settings");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function saveUnit(_prev: unknown, formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_settings");
    const input = unitInput.parse(Object.fromEntries(formData));
    const db = getDb();

    if (input.id) {
      await db
        .update(units)
        .set({ code: input.code, name: input.name, dimension: input.dimension, multiplierToBase: String(input.multiplierToBase) })
        .where(and(eq(units.id, input.id), eq(units.organizationId, tenant.organizationId)));
    } else {
      await db.insert(units).values({
        organizationId: tenant.organizationId,
        code: input.code,
        name: input.name,
        dimension: input.dimension,
        multiplierToBase: String(input.multiplierToBase),
        isBase: input.multiplierToBase === 1,
      });
    }

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: input.id ? "update" : "create", entityType: "unit", metadata: { code: input.code } });
    revalidatePath("/dashboard/settings");
    revalidatePath("/dashboard/ingredients");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteUnit(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_settings");
    await getDb().delete(units).where(and(eq(units.id, id), eq(units.organizationId, tenant.organizationId)));
    revalidatePath("/dashboard/settings");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
