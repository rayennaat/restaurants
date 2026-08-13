/**
 * The audit vocabulary.
 *
 * `audit_logs.action` and `audit_logs.entity_type` were free-form strings, so
 * nothing stopped two call sites describing the same event differently — and a
 * typo produced a row that no filter would ever match. These unions make the
 * vocabulary a closed set the compiler checks.
 *
 * Every value below is one that is *already written* by an existing call site.
 * This is a type over the current data, not a rename: no stored row changes
 * meaning, and no migration is required.
 *
 * Pure data and pure functions — no database, no Next.js — so it is testable
 * directly and safe to import from anywhere.
 */

/**
 * Generic lifecycle verbs, used by catalog records (ingredients, suppliers,
 * recipes, menu items, locations, units) where the entity type carries the
 * meaning and the verb is genuinely CRUD.
 */
export const AUDIT_LIFECYCLE_ACTIONS = ["create", "update", "delete", "archive", "restore"] as const;

/**
 * Named domain events, used where "update" would lose the point. Removing a
 * member and changing their role are both updates to one row; only the event
 * name distinguishes them when you are reading the log a year later.
 */
export const AUDIT_DOMAIN_ACTIONS = [
  // Organization lifecycle
  "complete_setup",
  "reopen_setup",
  // Team and access
  "employee_invited",
  "invitation_accepted",
  "invitation_resent",
  "invitation_revoked",
  "member_role_changed",
  "member_location_changed",
  "member_removed",
  // Inventory operations
  "waste_recorded",
  "stock_count_created",
  "stock_count_submitted",
  "stock_count_approved",
  "stock_count_rejected",
  "stock_count_discarded",
  // Sales
  "sale_recorded",
  "sale_voided",
  "sales_imported",
  // Transfers between locations
  "transfer_created",
  "transfer_sent",
  "transfer_received",
  "transfer_cancelled",
] as const;

export const AUDIT_ACTIONS = [...AUDIT_LIFECYCLE_ACTIONS, ...AUDIT_DOMAIN_ACTIONS] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  "organization",
  "location",
  "unit",
  "member",
  "invitation",
  "ingredient",
  "supplier",
  "supplier_product",
  "purchase",
  "recipe",
  "menu_item",
  "waste_entry",
  "stock_count",
  "sale",
  "sales_import",
  "stock_transfer",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function isAuditEntityType(value: unknown): value is AuditEntityType {
  return typeof value === "string" && (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

const ENTITY_LABELS: Record<AuditEntityType, string> = {
  organization: "workspace",
  location: "location",
  unit: "unit",
  member: "team member",
  invitation: "invitation",
  ingredient: "ingredient",
  supplier: "supplier",
  supplier_product: "supplier product",
  purchase: "purchase",
  recipe: "recipe",
  menu_item: "menu item",
  waste_entry: "waste entry",
  stock_count: "stock count",
  sale: "sale",
  sales_import: "sales import",
  stock_transfer: "stock transfer",
};

const DOMAIN_PHRASES: Record<(typeof AUDIT_DOMAIN_ACTIONS)[number], string> = {
  complete_setup: "completed workspace setup",
  reopen_setup: "reopened workspace setup",
  employee_invited: "invited an employee",
  invitation_accepted: "accepted an invitation",
  invitation_resent: "resent an invitation",
  invitation_revoked: "cancelled an invitation",
  member_role_changed: "changed a team member's role",
  member_location_changed: "changed a team member's default location",
  member_removed: "removed a team member",
  waste_recorded: "recorded waste",
  stock_count_created: "started a stock count",
  stock_count_submitted: "submitted a stock count for approval",
  stock_count_approved: "approved a stock count",
  stock_count_rejected: "rejected a stock count",
  stock_count_discarded: "discarded a draft stock count",
  sale_recorded: "recorded a sale",
  sale_voided: "voided a sale",
  sales_imported: "imported sales from a file",
  transfer_created: "created a stock transfer",
  transfer_sent: "sent a stock transfer",
  transfer_received: "received a stock transfer",
  transfer_cancelled: "cancelled a stock transfer",
};

const LIFECYCLE_PHRASES: Record<(typeof AUDIT_LIFECYCLE_ACTIONS)[number], string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  archive: "archived",
  restore: "restored",
};

/** "a supplier" but "an ingredient" — the log reads as prose, so this matters. */
function withArticle(noun: string) {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * Renders one entry as a sentence, for a log view or an export.
 *
 * Unknown values are passed through rather than dropped: an old row written
 * before a vocabulary change should still be readable, and silently hiding an
 * audit entry is the one thing an audit log must never do.
 */
export function describeAuditEntry(entry: { action: string; entityType: string }): string {
  const { action, entityType } = entry;

  if (isAuditAction(action) && (AUDIT_DOMAIN_ACTIONS as readonly string[]).includes(action)) {
    return DOMAIN_PHRASES[action as (typeof AUDIT_DOMAIN_ACTIONS)[number]];
  }

  const noun = isAuditEntityType(entityType) ? ENTITY_LABELS[entityType] : entityType.replace(/_/g, " ");

  if (isAuditAction(action) && (AUDIT_LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return `${LIFECYCLE_PHRASES[action as (typeof AUDIT_LIFECYCLE_ACTIONS)[number]]} ${withArticle(noun)}`;
  }

  return `${action.replace(/_/g, " ")} — ${noun}`;
}
