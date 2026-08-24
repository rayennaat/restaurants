import { issueOwnerOnboardingToken } from "../src/server/queries/owner-onboarding";
import { createOwnerOnboardingToken, hashOwnerOnboardingToken, normalizeOnboardingEmail, ownerOnboardingExpiry } from "../src/lib/owner-onboarding";
import { config } from "dotenv";

const USAGE = "Usage: npm run onboarding:issue-owner -- owner@example.com";
const HELP = `${USAGE}

Required arguments:
  owner@example.com  Email address that the single-use owner onboarding link is bound to.`;

function printHelp(): void {
  console.log(HELP);
}

async function main(): Promise<void> {
  const argument = process.argv[2] ?? "";

  if (argument === "--help" || argument === "-h") {
    printHelp();
    return;
  }

  const loaded = config({ path: ".env.staging", override: true });
  const migrationUrl = loaded.parsed?.DATABASE_MIGRATION_URL;
  const email = normalizeOnboardingEmail(argument);

  if (!email || !email.includes("@")) {
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  if (!migrationUrl) {
    throw new Error("DATABASE_MIGRATION_URL is missing from .env.staging. Token issuance aborted.");
  }

  let connection: URL;
  try {
    connection = new URL(migrationUrl);
  } catch {
    throw new Error("DATABASE_MIGRATION_URL in .env.staging is not a valid PostgreSQL URL. Token issuance aborted.");
  }

  if (connection.protocol !== "postgres:" && connection.protocol !== "postgresql:") {
    throw new Error("DATABASE_MIGRATION_URL must use the postgres protocol. Token issuance aborted.");
  }

  // The query layer reads DATABASE_URL, so bind it to the validated staging URL.
  process.env.DATABASE_URL = migrationUrl;

  const token = createOwnerOnboardingToken();
  const expiresAt = ownerOnboardingExpiry();
  await issueOwnerOnboardingToken(email, expiresAt, hashOwnerOnboardingToken(token));

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  console.log(`Owner onboarding URL: ${origin}/onboarding/${token}`);
  console.log(`Intended email: ${email}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Owner onboarding issuance failed.");
  process.exitCode = 1;
});
