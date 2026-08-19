import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "dotenv";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env.staging");
const backupDirectory = resolve(root, "backups");

if (!existsSync(envFile)) {
  console.error("Staging environment file .env.staging was not found. Backup aborted.");
  process.exit(1);
}

const loaded = config({ path: envFile, override: true, quiet: true });
if (loaded.error) {
  console.error("Could not load .env.staging. Backup aborted.");
  process.exit(1);
}

// Read only the value physically present in .env.staging. A migration URL
// inherited from the shell must never become an implicit fallback.
const migrationUrl = loaded.parsed?.DATABASE_MIGRATION_URL;
if (!migrationUrl) {
  console.error("DATABASE_MIGRATION_URL is missing from .env.staging. Backup aborted.");
  process.exit(1);
}

let connection;
try {
  connection = new URL(migrationUrl);
} catch {
  console.error("DATABASE_MIGRATION_URL in .env.staging is not a valid PostgreSQL URL. Backup aborted.");
  process.exit(1);
}

if (connection.protocol !== "postgres:" && connection.protocol !== "postgresql:") {
  console.error("DATABASE_MIGRATION_URL must use the postgres protocol. Backup aborted.");
  process.exit(1);
}

const pgDumpCheck = spawnSync("pg_dump", ["--version"], { stdio: "ignore" });
if (pgDumpCheck.error || pgDumpCheck.status !== 0) {
  console.error("pg_dump was not found on PATH. Install the PostgreSQL client tools before creating a backup.");
  process.exit(1);
}

mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const outputPath = resolve(backupDirectory, `platepilot-staging-${timestamp}.dump`);

let reservation;
try {
  reservation = openSync(outputPath, "wx");
  closeSync(reservation);
  reservation = undefined;
  chmodSync(outputPath, 0o600);

  const childEnvironment = {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGDATABASE: decodeURIComponent(connection.pathname.replace(/^\//, "")) || "postgres",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    ...(connection.searchParams.get("sslmode") ? { PGSSLMODE: connection.searchParams.get("sslmode") } : {}),
  };

  const result = spawnSync(
    "pg_dump",
    ["--format=custom", "--no-password", `--file=${outputPath}`],
    {
      cwd: root,
      env: childEnvironment,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pg_dump exited with status ${result.status ?? "unknown"}.`);
  }

  console.log(`Staging backup created: ${outputPath.replace(`${root}/`, "")}`);
} catch (error) {
  rmSync(outputPath, { force: true });
  const message = error instanceof Error ? error.message : "Unknown backup error.";
  console.error(`Staging backup failed: ${message}`);
  process.exit(1);
} finally {
  if (reservation !== undefined) closeSync(reservation);
}

