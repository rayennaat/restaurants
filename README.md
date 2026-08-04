# PlatePilot — Restaurant Profit & Operations OS

A production-oriented MVP for multi-location restaurant inventory, purchasing, waste tracking, recipe costing and profitability reporting.

## What is implemented

- Next.js 16 App Router, TypeScript and Tailwind CSS 4
- Mobile-first dashboard with shadcn-style editable UI components
- Supabase email/password authentication using `@supabase/ssr`
- PostgreSQL schema managed by Drizzle ORM and Drizzle Kit
- Multi-tenant organizations, locations, roles and tenant guards
- Append-only stock movement ledger
- Ingredient inventory, low-stock status, purchases and waste recording
- Atomic purchase/waste database transactions
- Idempotency keys for offline synchronization
- PWA service worker with Serwist
- Offline mutation queue with Dexie/IndexedDB
- TanStack Query provider and TanStack Table inventory grid
- Recharts waste analytics
- React Hook Form + Zod validation
- next-intl provider foundation
- Vitest unit tests, Playwright E2E tests and optional Sentry wiring
- RLS policy script for Supabase Data API protection
- Private Supabase Storage bucket policies and signed invoice upload endpoint
- GitHub Actions verification workflow

## 1. Requirements on Ubuntu

```bash
sudo apt update
sudo apt install -y git curl build-essential

# Install Node.js 22 with nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22

node -v
npm -v
```

## 2. Install the project

```bash
unzip restaurant-ops-os.zip
cd restaurant-ops-os
cp .env.example .env.local
npm install
```


### Packages installed by `npm install`

The dependency list is already in `package.json`. The equivalent grouped commands are:

```bash
npm install next react react-dom typescript tailwindcss @tailwindcss/postcss
npm install drizzle-orm postgres dotenv @supabase/supabase-js @supabase/ssr
npm install @tanstack/react-query @tanstack/react-table react-hook-form @hookform/resolvers zod
npm install next-intl recharts dexie @serwist/next serwist lucide-react sonner clsx tailwind-merge class-variance-authority
npm install @sentry/nextjs
npm install -D drizzle-kit tsx eslint eslint-config-next vitest jsdom @playwright/test @types/node @types/react @types/react-dom
```

Normally, use only `npm install`; do not run every line again unless you are recreating the project manually.

Preview immediately without a database:

```bash
# Keep NEXT_PUBLIC_DEMO_MODE=true in .env.local
npm run dev
```

Open `http://localhost:3000`.

## 3. Create the real PostgreSQL database in Supabase

1. Create a project in the Supabase dashboard.
2. Open **Project Settings / Connect**.
3. Copy:
   - Project URL
   - Publishable key
   - Transaction pooler connection string (port 6543)
   - Direct connection string or Session Pooler connection string (port 5432)
4. URL-encode special characters in your database password. For example, `@` becomes `%40`.

Update `.env.local`:

```env
NEXT_PUBLIC_DEMO_MODE=false
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

# Used by the running Next.js app. Transaction pooler; prepare=false is set in src/db/client.ts.
DATABASE_URL=postgresql://postgres.YOUR_PROJECT:ENCODED_PASSWORD@aws-0-YOUR_REGION.pooler.supabase.com:6543/postgres

# Used only by Drizzle Kit migrations. Direct/session connection.
DATABASE_MIGRATION_URL=postgresql://postgres:ENCODED_PASSWORD@db.YOUR_PROJECT.supabase.co:5432/postgres
# On an IPv4-only network, use Supabase Session Pooler on port 5432 instead.
```

### Why two database URLs?

Supabase's transaction pooler is suitable for serverless runtime connections, but prepared statements are not supported in transaction mode. The app therefore uses `postgres(..., { prepare: false })`. Schema migrations should use the direct/session connection so Drizzle can safely hold the connection while applying DDL.

## 4. Turn the Drizzle TypeScript schema into real PostgreSQL tables

The source of truth is `src/db/schema.ts`.

Generate SQL migration files:

```bash
npm run db:generate
```

Review the generated SQL inside `drizzle/`, then apply it to Supabase PostgreSQL:

```bash
npm run db:migrate
```

For rapid local prototyping only, you may push the schema directly:

```bash
npm run db:push
```

Use `generate` + `migrate` for production because the SQL is versioned in Git.

Open the database browser:

```bash
npm run db:studio
```

Verify that Next.js and Drizzle can reach the real PostgreSQL database:

```bash
npm run dev
curl http://localhost:3000/api/health
```

A working connection returns JSON with `"mode":"database"` and the PostgreSQL database name.

## 5. Apply Row Level Security

After migrations finish:

1. Open Supabase **SQL Editor**.
2. Copy all of `supabase/rls.sql`.
3. Run it once.
4. Then run `supabase/storage.sql` to create the private invoice bucket and its organization-scoped policies.

RLS protects tables when they are reached through Supabase's Data API. The Next.js server uses the privileged PostgreSQL connection, so every server query and mutation must also verify membership and filter by `organization_id`. This project does that through `getTenantContext()` and tenant-scoped queries. Never accept an organization ID directly from the browser and trust it.

## 6. Configure authentication

In Supabase:

1. Open **Authentication → URL Configuration**.
2. Set the local site URL to `http://localhost:3000`.
3. Add redirect URL `http://localhost:3000/auth/callback`.
4. For Vercel later, add `https://YOUR_DOMAIN/auth/callback`.
5. Keep email/password enabled.

Then:

```bash
npm run dev
```

Create an account at `/auth/sign-up`. The app sends you to `/onboarding`, where it creates:

- Organization
- First restaurant location
- Owner membership
- Standard mass, volume and count units

## 7. Optional sample data

After signing up, you can use the onboarding UI. Alternatively, set the user's UUID from **Authentication → Users**:

```env
SEED_USER_ID=YOUR_AUTH_USER_UUID
```

Then run:

```bash
npm run db:seed
```

## 8. Development commands

```bash
npm run dev          # Development server
npm run typecheck    # Strict TypeScript check
npm run lint         # ESLint
npm run test         # Costing unit tests
npm run test:e2e     # Playwright browser tests
npm run build        # Production build
npm run db:generate  # Generate migrations from schema
npm run db:migrate   # Apply migrations
npm run db:studio    # Visual database browser
```

Install Playwright's browser once:

```bash
npx playwright install chromium
```

## 9. Vercel deployment

Add the same environment variables in Vercel, but never expose `DATABASE_URL` or `DATABASE_MIGRATION_URL` as public variables. `NEXT_PUBLIC_*` values are visible to browsers by design; the Supabase publishable key is intended for this use and RLS must remain enabled.

Recommended production variables:

```env
NEXT_PUBLIC_DEMO_MODE=false
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
DATABASE_URL=...transaction-pooler...
NEXT_PUBLIC_SENTRY_DSN=...optional...
```

Do not add `DATABASE_MIGRATION_URL` to Vercel unless you deliberately run migrations from CI. Run migrations from your trusted development/CI environment.

## 10. Important production work still required

This is a serious MVP foundation, not a finished commercial ERP. Before charging restaurants, add:

- Role-specific authorization per action, not only organization membership
- Audit log writes for sensitive changes
- Recipe editing and versioning UI
- Multi-line supplier invoices
- Stock counts and variance approval
- Transfers between locations
- CSV/POS imports
- Automatic tests against a staging Supabase project
- Backups, support process, privacy policy and security review
- Tunisia payment flow and Stripe Billing for the U.S. version

## Architecture decision

Start as a modular monolith. Do not split inventory, recipes, reporting and notifications into microservices until real scale proves the need. PostgreSQL transactions are a major advantage for stock and costing correctness.
