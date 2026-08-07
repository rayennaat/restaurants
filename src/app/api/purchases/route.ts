import { NextResponse } from "next/server";
import { receivePurchase } from "@/server/actions/purchases";

/**
 * Multi-line purchase receiving over HTTP.
 *
 * The offline queue replays queued mutations through this endpoint, so it
 * delegates to the same server action the invoice builder uses. A duplicate
 * `clientOperationId` is reported as 409 so the queue drops the entry instead
 * of retrying it forever.
 */
export async function POST(request: Request) {
  try {
    const result = await receivePurchase(await request.json());
    if (!result.ok) {
      const isDuplicate = result.error.toLowerCase().includes("already");
      return NextResponse.json({ error: result.error, fieldErrors: result.fieldErrors }, { status: isDuplicate ? 409 : 400 });
    }
    return NextResponse.json(result.data, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}
