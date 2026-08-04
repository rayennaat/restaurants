import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/server/tenant";

const inputSchema = z.object({
  filename: z.string().min(1).max(180).regex(/^[a-zA-Z0-9._-]+$/),
});

export async function POST(request: Request) {
  try {
    const tenant = await getTenantContext();
    if (!tenant || "needsOnboarding" in tenant || !tenant.locationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
      return NextResponse.json({ ok: true, demo: true, path: "demo/invoice.pdf" });
    }

    const input = inputSchema.parse(await request.json());
    const supabase = await createClient();
    const path = `${tenant.organizationId}/${tenant.locationId}/${new Date().getUTCFullYear()}/${crypto.randomUUID()}-${input.filename}`;
    const { data, error } = await supabase.storage.from("invoices").createSignedUploadUrl(path);
    if (error) throw error;
    return NextResponse.json({ path, token: data.token, signedUrl: data.signedUrl });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create upload URL" },
      { status: 400 },
    );
  }
}
