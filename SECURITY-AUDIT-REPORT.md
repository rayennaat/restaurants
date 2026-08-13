# Security and Production-Readiness Audit

Date: 2026-08-12
Scope: Restaurant Profit & Operations OS repository and the configured Supabase/PostgreSQL environment.

This report records what was inspected, what was reproduced, what was fixed, and what still requires production infrastructure or manual verification. It does not claim that passing tests makes the system universally secure.

## Executive Summary

The audit found and fixed two direct application authorization leaks, one direct Storage API role/location bypass, seventeen privileged-connection tenant-integrity gaps, a set of non-transactional audit paths, and a concurrency weakness in last-owner protection. The database and application now have layered tenant, role, location, validation, constraint, transaction, and audit controls.

Final automated evidence:

- 73/73 rollback-only live database and Storage security probes passed.
- 35/35 rollback-only inventory, sales, import, count and transfer integrity probes passed.
- 959/959 Vitest tests passed.
- 4/4 Playwright smoke tests passed across desktop and mobile projects.
- TypeScript passed.
- Production build passed on Next.js 16.3.0.
- Lint passed with six non-blocking warnings.
- Production dependency audit passed with zero vulnerabilities using `npm audit --omit=dev`.
- Full dependency audit retains four moderate advisories in the development-only `drizzle-kit` legacy `@esbuild-kit` loader. The available fix is an incompatible Drizzle Kit downgrade and was not applied.

## Critical Findings

No critical findings remain from the audited code and configured database.

## High Findings

### H-01: Privileged server connection accepted cross-tenant references

Status: Fixed and verified.

What was wrong: ordinary foreign keys proved that referenced UUIDs existed, but did not prove that locations, ingredients, suppliers, recipes, sales, imports, counts, and transfers belonged to the row's organization. The server uses a privileged PostgreSQL connection that bypasses RLS, so a missed application check could have created mixed-tenant records.

Why it mattered: mixed references could expose another tenant's names or prices through joins, misattribute stock or spend, and undermine tenant isolation even though browser-role RLS probes passed.

Fix: added migration `drizzle/0010_tenant_integrity.sql` with same-organization composite foreign keys, inherited-tenant triggers for child tables, and scalar financial/quantity checks. The migration is registered in `drizzle/meta/_journal.json`.

Testing: the expanded live probe first reproduced all 17 accepted invalid states, then after `npm run db:migrate` rejected all 17. The final result was 73/73 passed, inside a transaction that always rolled back.

### H-02: Invoice Storage policies bypassed role and location authorization

Status: Fixed and verified.

What was wrong: the signed upload route checked `manage_purchasing`, but direct Supabase Storage policies allowed any organization member to insert, update, delete, or read invoice objects. Paths also allowed a caller to name a sibling location.

Why it mattered: a kitchen or accountant user could bypass the route and write financial files directly; a site-bound user could access or manipulate another site's invoices.

Fix: added security-definer helpers in `supabase/rls.sql` and changed `supabase/storage.sql` policies to enforce purchasing roles and path organization/location scope. Storage policies are now idempotent with drop-then-create.

Testing: live probes verify kitchen cannot upload, inventory can upload at its assigned location, inventory cannot upload at a sibling location, kitchen can read its own location, and kitchen cannot read a sibling location. Installed policy expressions are inspected directly from `pg_policies`.

### H-03: Site-bound users could open sibling-location purchase and transfer details by URL

Status: Fixed and verified.

What was wrong: purchase and transfer detail pages fetched same-organization records by ID but did not always check whether a site-bound member was authorized for the stored location(s). List filtering and hidden buttons were not sufficient.

Why it mattered: changing a URL parameter exposed purchase invoice totals, supplier information, transfer routes, quantities, values, and history from an unauthorized location.

Fix: purchase detail now requires the member's location to match the purchase location. Transfer detail now requires a site-bound member to be assigned to either source or destination. Regression checks were added to `src/server/security-regression.test.ts`.

Testing: structural regressions cover both pages. The shared location write guards and live location probes cover related mutation paths.

## Medium Findings

### M-01: Sales import history exposed sibling-location runs

Status: Fixed and verified by regression coverage.

What was wrong: import history was organization-wide even for site-bound members, exposing filenames, row counts, values and statuses from other locations.

Fix: `listSalesImports` accepts an optional location scope and the history page passes `resolveMemberLocation` output.

Testing: regression coverage asserts the page resolves member location and passes it to the query. The query filters by organization and location.

### M-02: Purchase UI exposed all active locations to site-bound users

Status: Fixed and verified by regression coverage.

What was wrong: the purchase page loaded every active organization location into its form. The mutation rejected unauthorized locations, but the UI disclosed sibling location names and presented a control that could never succeed.

Fix: purchase location options now come from `resolveMemberLocation`; non-purchasing roles are shown history without a new-invoice control.

Testing: regression coverage asserts member-location resolution, option narrowing, and scoped purchase listing.

### M-03: Invitation acceptance assumed email verification was configured globally

Status: Fixed and verified.

What was wrong: invitation matching relied on `user.email` and comments assumed Supabase had already verified it. A project configuration that allowed unconfirmed sessions would weaken mailbox ownership proof.

Why it mattered: an unverified account could potentially claim an invitation addressed to that email.

Fix: both invitation preview and `acceptInvitation` require `user.email_confirmed_at` before using the address for redemption.

Testing: invitation unit tests cover mismatch, expiry, replay, role restrictions and token handling; source regressions require the confirmation check in both preview and action.

### M-04: Last-owner protection was not serialized

Status: Fixed and verified by code review/typecheck/tests.

What was wrong: role-change and removal paths counted owners before opening their mutation transaction. Two concurrent requests could observe two owners and demote/remove both.

Fix: owner-sensitive team mutations now take an organization-scoped PostgreSQL transaction advisory lock before reading owner state and mutating it. Invitation claiming is also one conditional, transaction-bound path for both new and existing members, with one audit event.

Testing: TypeScript, permission, security-regression and audit-coverage suites pass. A production concurrency test with two authenticated owners remains a manual staging check.

### M-05: Sensitive mutation audit rows were not always transaction-bound

Status: Fixed.

What was wrong: `recordAudit` intentionally swallows errors when called without a transaction. Several settings, ingredient-cost, supplier-price, and stock-count status mutations could therefore succeed while their audit insert failed.

Fix: transaction-bound audit logging now covers ingredient saves, supplier and supplier-product saves, organization setup/settings, location/unit saves, and stock-count submit/reject. The existing autosave and read-only import preview remain explicitly exempt.

Testing: audit coverage expanded from 77 to 87 checks and requires `tx` for all security-critical mutations. Full suite passes.

### M-06: Transfer conversion errors could expose internal exception text

Status: Fixed.

What was wrong: a conversion catch returned `error.message` directly to callers.

Fix: `createTransfer` now returns a controlled incompatible-unit message and does not expose helper/driver text.

Testing: TypeScript, lint, security regressions and full tests pass.

## Low Findings

### L-01: Development-only dependency advisories remain

Status: Accepted with scope documented.

The production dependency audit is clean. Full `npm audit` reports four moderate findings through `drizzle-kit` -> `@esbuild-kit` -> legacy `esbuild`. The suggested automated fix downgrades Drizzle Kit to an incompatible 0.18.1 release, so it was not applied blindly. The affected tool is used for migrations and development, not shipped in the production runtime. Reassess on the next compatible Drizzle Kit release and run migration commands only in trusted environments.

### L-02: Lint warnings remain

Status: Accepted, non-blocking.

Lint exits successfully with six warnings: one PostCSS anonymous-default-export warning and five React Compiler compatibility warnings for React Hook Form/TanStack Table. No audit change required a risky refactor of working form/table behavior.

## Fixed Controls Confirmed During Audit

- Server actions establish the authenticated tenant and role before mutation parsing/work.
- Organization IDs are never accepted from mutation payload schemas.
- Role matrix is exhaustive and tested for owner, manager, inventory, kitchen and accountant.
- Site-bound reads and writes use stored/requested location checks.
- Sales use server-resolved menu prices; waste uses server-resolved ingredient cost; imports rebuild server plans.
- Quantities, prices, dates, UUIDs, enums, text lengths and upload sizes are validated server-side.
- Database checks reject negative financial values, invalid quantities, invalid transfer state, invalid count state, and inconsistent sale line totals.
- Sales are idempotent by organization/source/external ID.
- Sale lines and terminal stock counts are immutable at the database layer.
- Audit logs are append-only, including against the privileged PostgreSQL connection.
- Audit records for sensitive mutations roll back with the mutation.
- Invitation tokens are CSPRNG values; only SHA-256 hashes are stored; expiry, status, email, role and replay are checked.
- Owner cannot be granted by invite; owner changes require the owner-only permission.
- Open redirects are blocked with a same-origin path whitelist that rejects backslashes and URL-parser control characters.
- Unrecognized server errors return a correlation reference rather than SQL, stack, path or driver details.
- No service-role key is referenced in application code; client components use only public Supabase/Sentry variables.
- Demo mode is disabled whenever `NODE_ENV=production`.
- Response headers include frame denial, MIME sniffing protection, strict-origin referrer policy and a restrictive permissions policy.

## Accepted Risks

- The application runtime currently connects through the configured Supabase pooled database URL. The repository cannot create or rotate the production role model; production should use a dedicated least-privileged runtime role instead of a database owner connection.
- A full CSP with per-request nonces is not enabled. `frame-ancestors` is set, but a complete nonce policy requires validating Next.js, Sentry, service-worker and inline bootstrap behavior.
- Browser E2E tests cover public login and demo health only. They do not authenticate real users or prove multi-tenant browser workflows.
- The audit logger intentionally permits non-critical catalog edits to continue if the standalone audit insert fails. Critical mutations are transaction-bound; this distinction is documented in `src/server/audit.ts`.
- Development-only Drizzle Kit advisories remain until a compatible tool upgrade exists.

## Manual Testing Required

- Two real Supabase users in different organizations: verify cross-tenant reads, writes, edits and deletes through server actions, route handlers, direct URLs and Storage API calls.
- Owner, manager, inventory, kitchen and accountant accounts across at least two locations: verify every inventory, purchase, waste, sales, count, transfer and report URL/query/body manipulation path.
- Two concurrent owner role changes/removals and two concurrent invitation redemptions against staging.
- Expired session, refresh-token rotation, sign-out from multiple tabs, callback errors, password reset, unverified-email sign-in and invite replay.
- Storage upload/read/update/delete with own and sibling location folders for every role.
- Restore a backup into an isolated project and rerun migrations, RLS, Storage policies, security probes and integrity probes.

## Production Infrastructure Requirements

- Supabase Auth must require verified email for normal access, use exact production site/redirect allowlists, configured SMTP, abuse/rate limits and an MFA policy for privileged users.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, and optionally `NEXT_PUBLIC_SENTRY_DSN` must be configured in the correct scopes. `DATABASE_MIGRATION_URL` must remain trusted CI/operator-only and must never be public.
- Apply `npm run db:migrate`, then `supabase/rls.sql`, then `supabase/storage.sql` to every environment and verify policy convergence.
- Enable backups/PITR, monitoring, alerting, log retention, incident response, support access controls and an audit-log retention policy.
- Run staging probes automatically after migrations. Do not use the live customer database for fixture-based probes unless the transaction rollback behavior is independently reviewed.

## Remaining Blockers Before Charging Real Customers

1. Provision and verify a least-privileged production runtime database role.
2. Complete Supabase Auth, SMTP, redirect, abuse-limit and privileged-account MFA configuration.
3. Establish tested backups/PITR and a recovery runbook.
4. Complete authenticated cross-tenant and multi-location staging browser testing.
5. Add monitoring, alerting, incident response, privacy/data-processing terms and support access controls.
6. Decide and implement a nonce-based CSP after compatibility testing.
7. Resolve or formally accept the development-tool dependency advisory with a documented maintenance plan.
8. Complete market-specific payment, tax, billing and customer-contract requirements.

## Verification Commands

```text
npm run typecheck       PASS
npm test                PASS: 959 tests
npm run lint            PASS: 0 errors, 6 warnings
npm run build           PASS: Next.js 16.3.0 production build
npm run verify:security PASS: 73/73 live rollback-only checks
npm run verify:integrity PASS: 35/35 live rollback-only checks
npm run test:e2e        PASS: 4 desktop/mobile smoke tests
npm audit --omit=dev    PASS: 0 vulnerabilities
npm audit               4 moderate development-only Drizzle Kit/esbuild advisories
```
