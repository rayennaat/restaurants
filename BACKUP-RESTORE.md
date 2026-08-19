# Staging Database Backup and Restore

This is the temporary manual backup process for the PlatePilot staging/pilot database while managed Supabase backups and point-in-time recovery are deferred.

## Prerequisites

- Install PostgreSQL client tools so `pg_dump` and `pg_restore` are available on `PATH`.
- Keep `.env.staging` local and ignored by Git.
- Set `DATABASE_MIGRATION_URL` in `.env.staging` to the staging direct/session PostgreSQL connection. The backup command does not use `DATABASE_URL` and has no local or production fallback.

Confirm the client tools are available without showing connection details:

```bash
pg_dump --version
pg_restore --version
```

## Create a Staging Backup

From the repository root, run:

```bash
npm run db:backup:staging
```

The command:

- reads `DATABASE_MIGRATION_URL` only from `.env.staging`;
- creates a PostgreSQL custom-format dump with `pg_dump --format=custom`;
- writes `backups/platepilot-staging-YYYYMMDDTHHMMSSZ.dump`;
- sets the dump to owner-only permissions where supported;
- deletes an incomplete dump if `pg_dump` fails;
- never prints the connection URL or password.

`backups/`, `*.dump`, `*.backup`, and `*.sql.gz` are ignored by Git. Store copies only in an approved encrypted location with access restricted to operators who are authorized to handle pilot/customer data.

## Inspect a Backup

Listing archive contents is read-only and does not connect to a database:

```bash
pg_restore --list backups/platepilot-staging-YYYYMMDDTHHMMSSZ.dump
```

## Restore Later

Do not restore as part of routine backup creation. Restore first into a new, isolated Supabase project or disposable PostgreSQL database, never directly over staging or production without an approved recovery operation.

Set an explicit destination connection in the current shell. Keep the password out of command arguments, documentation, scripts, Git, tickets, and chat logs:

```bash
export PGHOST='DESTINATION_HOST'
export PGPORT='5432'
export PGDATABASE='postgres'
export PGUSER='DESTINATION_USER'
export PGPASSWORD='DESTINATION_PASSWORD'
export PGSSLMODE='require'
```

Restore the custom-format archive:

```bash
pg_restore \
  --no-password \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  backups/platepilot-staging-YYYYMMDDTHHMMSSZ.dump
```

`--clean` drops objects represented in the archive before recreating them. It is destructive to the destination database. Verify the destination host/project twice before running it.

After restoring into an isolated project:

1. Confirm migrations and application schema are present.
2. Reapply and verify Supabase RLS and Storage policies if the destination project requires them.
3. Run the security and integrity verification commands against that isolated destination.
4. Perform an authenticated application smoke test.
5. Record the restore date, backup filename, operator, result, and recovery time.

Unset the temporary destination URL when finished:

```bash
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE
```

Managed backups/PITR should replace this process before production customer data is accepted.
