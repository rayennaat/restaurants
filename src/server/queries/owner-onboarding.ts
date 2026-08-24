import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ownerOnboardingTokens } from "@/db/schema";
import { checkOwnerOnboardingRedeemable, hashOwnerOnboardingToken, type OwnerOnboardingRejection } from "@/lib/owner-onboarding";

export type OwnerOnboardingPreview = {
  id: string;
  email: string;
  status: string;
  expiresAt: Date;
};

export async function findOwnerOnboardingByTokenHash(tokenHash: string): Promise<OwnerOnboardingPreview | null> {
  const [row] = await getDb()
    .select({
      id: ownerOnboardingTokens.id,
      email: ownerOnboardingTokens.email,
      status: ownerOnboardingTokens.status,
      expiresAt: ownerOnboardingTokens.expiresAt,
    })
    .from(ownerOnboardingTokens)
    .where(eq(ownerOnboardingTokens.tokenHash, tokenHash))
    .limit(1);

  return row ?? null;
}

export async function checkOwnerOnboardingToken(
  token: string,
  signedInEmail: string | null,
): Promise<{ preview: OwnerOnboardingPreview | null; rejection: OwnerOnboardingRejection | null }> {
  const preview = await findOwnerOnboardingByTokenHash(hashOwnerOnboardingToken(token));
  return {
    preview,
    rejection: checkOwnerOnboardingRedeemable(preview, signedInEmail),
  };
}

export async function claimOwnerOnboardingToken(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  tokenId: string,
  userId: string,
): Promise<boolean> {
  const [claimed] = await tx
    .update(ownerOnboardingTokens)
    .set({ status: "claimed", claimedAt: new Date(), claimedBy: userId, updatedAt: new Date() })
    .where(and(eq(ownerOnboardingTokens.id, tokenId), eq(ownerOnboardingTokens.status, "pending")))
    .returning({ id: ownerOnboardingTokens.id });

  return Boolean(claimed);
}

export async function issueOwnerOnboardingToken(email: string, expiresAt: Date, tokenHash: string) {
  const [row] = await getDb()
    .insert(ownerOnboardingTokens)
    .values({ email, expiresAt, tokenHash, status: "pending" })
    .returning({ id: ownerOnboardingTokens.id });
  return row.id;
}

export async function revokeOwnerOnboardingToken(tokenId: string): Promise<boolean> {
  const [row] = await getDb()
    .update(ownerOnboardingTokens)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(ownerOnboardingTokens.id, tokenId), eq(ownerOnboardingTokens.status, "pending")))
    .returning({ id: ownerOnboardingTokens.id });
  return Boolean(row);
}

export { hashOwnerOnboardingToken };
