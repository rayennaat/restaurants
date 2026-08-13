import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_DOMAIN_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_LIFECYCLE_ACTIONS,
  describeAuditEntry,
  isAuditAction,
  isAuditEntityType,
} from "@/lib/audit-actions";

describe("audit vocabulary", () => {
  it("is the union of lifecycle verbs and named domain events", () => {
    expect(AUDIT_ACTIONS).toEqual([...AUDIT_LIFECYCLE_ACTIONS, ...AUDIT_DOMAIN_ACTIONS]);
  });

  it("recognises its own members and rejects anything else", () => {
    for (const action of AUDIT_ACTIONS) expect(isAuditAction(action)).toBe(true);
    for (const entity of AUDIT_ENTITY_TYPES) expect(isAuditEntityType(entity)).toBe(true);

    for (const value of ["", "CREATE", "destroy", "member_promoted", null, undefined, 7, {}]) {
      expect(isAuditAction(value)).toBe(false);
      expect(isAuditEntityType(value)).toBe(false);
    }
  });

  it("keeps ownership-relevant team events as distinct names, not generic updates", () => {
    // Removing a member and changing their role are both row updates. Only the
    // event name tells them apart when reading the log later.
    for (const event of ["member_role_changed", "member_removed", "member_location_changed"]) {
      expect(AUDIT_DOMAIN_ACTIONS).toContain(event);
    }
  });

  it("covers the whole stock count lifecycle", () => {
    for (const event of [
      "stock_count_created",
      "stock_count_submitted",
      "stock_count_approved",
      "stock_count_rejected",
      "stock_count_discarded",
    ]) {
      expect(AUDIT_DOMAIN_ACTIONS).toContain(event);
    }
  });
});

describe("describeAuditEntry", () => {
  it("renders a domain event as its own sentence, ignoring the entity noun", () => {
    expect(describeAuditEntry({ action: "stock_count_approved", entityType: "stock_count" })).toBe("approved a stock count");
    expect(describeAuditEntry({ action: "member_removed", entityType: "member" })).toBe("removed a team member");
    expect(describeAuditEntry({ action: "waste_recorded", entityType: "waste_entry" })).toBe("recorded waste");
  });

  it("renders a lifecycle verb against the entity noun", () => {
    expect(describeAuditEntry({ action: "create", entityType: "supplier" })).toBe("created a supplier");
    expect(describeAuditEntry({ action: "archive", entityType: "ingredient" })).toBe("archived an ingredient");
    expect(describeAuditEntry({ action: "delete", entityType: "menu_item" })).toBe("deleted a menu item");
    expect(describeAuditEntry({ action: "update", entityType: "organization" })).toBe("updated a workspace");
  });

  it("still renders a row written before the vocabulary changed", () => {
    // Hiding an unrecognised entry is the one thing an audit log must not do.
    const described = describeAuditEntry({ action: "some_old_event", entityType: "legacy_thing" });
    expect(described).toContain("some old event");
    expect(described).toContain("legacy thing");
  });

  it("produces a non-empty description for every valid combination", () => {
    for (const action of AUDIT_ACTIONS) {
      for (const entityType of AUDIT_ENTITY_TYPES) {
        expect(describeAuditEntry({ action, entityType }).trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("metadata round-trips as JSON", () => {
  // recordAudit stores metadata as JSON in a text column, so anything it is
  // handed must survive stringify → parse without losing its meaning.
  it("preserves the fields the approval summary depends on", () => {
    const metadata = {
      locationName: "La marsa",
      itemCount: 42,
      varianceCount: 7,
      positiveValueMillis: 340_000,
      negativeValueMillis: -580_000,
      netValueMillis: -240_000,
      movementsCreated: 7,
    };
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  });

  it("preserves a role transition and an explicit null", () => {
    const metadata = { from: "kitchen", to: "manager", defaultLocationId: null };
    const parsed = JSON.parse(JSON.stringify(metadata));
    expect(parsed).toEqual(metadata);
    // Null must survive as null, not vanish — "unassigned" is a real answer.
    expect(parsed.defaultLocationId).toBeNull();
  });

  it("keeps negative money exact, since variance is signed", () => {
    const parsed = JSON.parse(JSON.stringify({ estimatedCostMillis: -54_000 }));
    expect(parsed.estimatedCostMillis).toBe(-54_000);
    expect(Number.isInteger(parsed.estimatedCostMillis)).toBe(true);
  });
});
