import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

const ENV_FILES = {
  local: ".env.local",
  staging: ".env.staging",
} as const;

type DatabaseEnvironment = keyof typeof ENV_FILES;

const requestedEnvironment = process.env.DB_ENV ?? "local";

if (!(requestedEnvironment in ENV_FILES)) {
  throw new Error(`Invalid DB_ENV "${requestedEnvironment}". Use "local" or "staging".`);
}

const databaseEnvironment = requestedEnvironment as DatabaseEnvironment;
const envFile = ENV_FILES[databaseEnvironment];
const loaded = config({ path: envFile });

if (loaded.error) {
  throw new Error(`Could not load ${envFile}: ${loaded.error.message}`);
}

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error(`Set DATABASE_MIGRATION_URL or DATABASE_URL in ${envFile} before running Drizzle commands.`);

console.log(`Drizzle database environment: ${databaseEnvironment} (${envFile})`);

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
