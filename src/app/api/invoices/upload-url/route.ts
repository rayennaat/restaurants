import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo-mode";
import { toActionError } from "@/server/action-result";
import { getTenantContext, hasPermission } from "@/server/tenant";

const inputSchema = z.object({
  filename: z.string().min(1).max(180).regex(/^[a-zA-Z0-9._-]+$/),
});

/**
 * Issues a signed URL for uploading a supplier invoice.
 *
 * The storage path is composed on the server from the session's organization and
 * location, so a caller cannot aim an upload at another tenant's folder — which
 * is what the matching `storage.objects` policies check on the way in.
 *
 * Guarded by `manage_purchasing`, the same permission that receives an invoice.
 * Membership alone was not enough: an accountant is read-only everywhere else in
 * the product, and a signed URL is a write — it puts a file in the workspace's
 * bucket, under its name, at its expense.
 */
export async function POST(request: Request) {
  try {
    const tenant = await getTenantContext();
    if (!tenant || "needsOnboarding" in tenant || !tenant.locationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(tenant.role, "manage_purchasing")) {
      return NextResponse.json({ error: "Your role does not allow uploading invoices." }, { status: 403 });
    }
    if (isDemoMode()) {
      return NextResponse.json({ ok: true, demo: true, path: "demo/invoice.pdf" });
    }

    const input = inputSchema.parse(await request.json());
    const supabase = await createClient();
    const path = `${tenant.organizationId}/${tenant.locationId}/${new Date().getUTCFullYear()}/${crypto.randomUUID()}-${input.filename}`;
    const { data, error } = await supabase.storage.from("invoices").createSignedUploadUrl(path);
    if (error) throw error;
    return NextResponse.json({ path, token: data.token, signedUrl: data.signedUrl });
  } catch (error) {
    // Storage errors quote bucket configuration and project internals; the
    // shared translator keeps those in the log and returns a reference instead.
    const failure = toActionError(error);
    return NextResponse.json({ error: failure.error, fieldErrors: failure.fieldErrors }, { status: 400 });
  }
}
