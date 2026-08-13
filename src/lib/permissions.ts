import { ActionError } from "@/lib/action-error";

/**
 * Authorization policy.
 *
 * Pure data and pure functions: no database, no Supabase, no Next.js. Keeping
 * the policy free of I/O is what lets the whole matrix be asserted directly in
 * unit tests, and it means the rules can be read in one sitting without
 * following a call into a query layer.
 *
 * `server/tenant` re-exports everything here, so application code continues to
 * import authorization from one place.
 */

/**
 * Active staff roles. `viewer` was retired: it granted nothing that
 * `accountant` does not, and every screen is readable by any member anyway.
 * The Postgres enum still carries the label — a value cannot be dropped from an
 * enum type — but nothing in the application can read or write it.
 */
export const MEMBER_ROLES = ["owner", "manager", "inventory", "kitchen", "accountant"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  manager: "Manager",
  inventory: "Inventory",
  kitchen: "Kitchen",
  accountant: "Accountant",
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: "Full access, including team and ownership transfer.",
  manager: "Runs day-to-day operations and the team, but cannot transfer ownership.",
  inventory: "Stock, purchasing and suppliers. No team or settings access.",
  kitchen: "Recipes, menu and daily operations. No purchasing or team access.",
  accountant: "Read-only across the workspace, including financial reports.",
};

/**
 * Roles an invitation may grant. `owner` is deliberately absent: ownership is
 * transferred through an explicit promotion that requires `transfer_ownership`,
 * never handed out by an invite link.
 */
export const INVITABLE_ROLES = ["manager", "inventory", "kitchen", "accountant"] as const satisfies readonly MemberRole[];
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/**
 * Narrows a role read from the database to an active one.
 *
 * The `member_role` enum still contains `viewer`, so a row written before the
 * role was retired would otherwise widen every downstream type. Such a row maps
 * to `accountant`, the closest surviving role: read everything, write nothing.
 * This is the single point where the retired label is translated away.
 */
export function normalizeRole(role: string): MemberRole {
  return isMemberRole(role) ? role : "accountant";
}

/**
 * The authorization matrix. One table, so a role's reach can be audited by
 * reading a single screen rather than grepping for `role === "owner"`.
 *
 * These are *write* permissions. Reading stays open to any member of the
 * organization, which is what the screens already assume — an accountant who
 * cannot modify a recipe can still see what it costs.
 */
const ROLE_PERMISSIONS = {
  /** Ingredients: the raw catalog everyone builds on. */
  manage_ingredients: ["owner", "manager", "inventory", "kitchen"],
  /** Preparations and dishes. Kitchen owns these; inventory does not. */
  manage_recipes: ["owner", "manager", "kitchen"],
  /** Suppliers and their price lists. */
  manage_suppliers: ["owner", "manager", "inventory"],
  /** Receiving invoices, which moves both stock and cost. */
  manage_purchasing: ["owner", "manager", "inventory"],
  /**
   * Day-to-day stock movements: waste, adjustments, and moving stock between
   * locations.
   *
   * Transfers are deliberately here rather than behind a new permission. Sending
   * and receiving are shop-floor acts — someone loads a van, someone unpacks it
   * — and the people who already record waste and count shelves are the people
   * who do them. What stops a cook moving another branch's stock is not a
   * separate permission but *location* authorization: every transfer action
   * checks the caller against the source (to send) or the destination (to
   * receive), so a site-bound member can only move stock across their own
   * threshold.
   */
  record_operations: ["owner", "manager", "inventory", "kitchen"],
  /** Starting and submitting a physical count. */
  manage_stock_counts: ["owner", "manager", "inventory"],
  /** Approving a count, which writes adjustment movements into the ledger. */
  approve_stock_counts: ["owner", "manager"],
  /**
   * Recording, importing and voiding sales.
   *
   * Narrower than `record_operations` on purpose. Waste and adjustments are
   * shop-floor facts that inventory and kitchen staff observe first-hand, but
   * sales are the revenue side of the books: they drive food cost percentage
   * and every profitability figure. Owners and managers run that. Accountants
   * stay read-only here as everywhere, which is enough to report on sales
   * without being able to alter them.
   */
  manage_sales: ["owner", "manager"],
  /** Inviting staff, changing roles, removing members. */
  manage_team: ["owner", "manager"],
  /** Organization profile, locations, units. */
  manage_settings: ["owner", "manager"],
  /** Granting or revoking the owner role. Owner only, by design. */
  transfer_ownership: ["owner"],
} satisfies Record<string, readonly MemberRole[]>;

export type Permission = keyof typeof ROLE_PERMISSIONS;

export const PERMISSIONS = Object.keys(ROLE_PERMISSIONS) as Permission[];

/** Non-throwing check, for deciding whether to render a control. */
export function hasPermission(role: MemberRole, permission: Permission) {
  return (ROLE_PERMISSIONS[permission] as readonly MemberRole[]).includes(role);
}

/**
 * Throwing check for server actions and route handlers. Hiding a button is a
 * convenience; this is the thing that actually stops the request.
 */
export function requirePermission(role: MemberRole, permission: Permission) {
  if (!hasPermission(role, permission)) {
    throw new ActionError("Your role does not allow this action.");
  }
}

/** Guards actions restricted to one specific role, e.g. ownership transfer. */
export function requireRole(role: MemberRole, allowed: MemberRole | MemberRole[]) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(role)) throw new ActionError("Your role does not allow this action.");
}

/**
 * Blocks self-targeted team actions. Without this, a manager could demote or
 * remove themselves and strand the workspace, and any member could escalate by
 * editing their own row.
 */
export function assertNotSelf(actorUserId: string, targetUserId: string, message = "You cannot perform this action on your own membership.") {
  if (actorUserId === targetUserId) throw new ActionError(message);
}

/**
 * Whether a role may work across every location in the organization.
 *
 * Owners and managers run the business and accountants report on all of it.
 * Inventory and kitchen staff belong to a site, so their queries and writes are
 * pinned to their `defaultLocationId` regardless of what the URL asks for —
 * see `resolveMemberLocation` in `queries/locations`.
 */
export function canAccessAllLocations(role: MemberRole) {
  return role === "owner" || role === "manager" || role === "accountant";
}
