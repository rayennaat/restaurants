import { NextResponse } from "next/server";
import { receivePurchase } from "@/server/actions/purchases";
import { toActionError } from "@/server/action-result";

/**
 * Multi-line purchase receiving over HTTP.
 *
 * The offline queue replays queued mutations through this endpoint, so it
 * delegates to the same server action the invoice builder uses — authentication,
 * `manage_purchasing`, location authorization and validation all happen there,
 * once, rather than being restated here where they could drift.
 *
 * A duplicate `clientOperationId` is reported as 409 so the queue drops the
 * entry instead of retrying it forever.
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
    // Only reachable if the body is not JSON at all — the action returns its own
    // failures. Translated rather than echoed so a parser or driver message
    // cannot become the response body.
    const failure = toActionError(error);
    return NextResponse.json({ error: failure.error }, { status: 400 });
  }
}
