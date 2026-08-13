import { describe, expect, it } from "vitest";
import {
  assertNotSelf,
  canAccessAllLocations,
  hasPermission,
  INVITABLE_ROLES,
  isMemberRole,
  MEMBER_ROLES,
  normalizeRole,
  PERMISSIONS,
  requirePermission,
  requireRole,
  type MemberRole,
  type Permission,
} from "@/lib/permissions";
import {
  checkInvitationRedeemable,
  createInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  tokenHashEquals,
  INVITATION_REJECTION_MESSAGES,
} from "@/lib/invitations";
import { invitableRole, inviteEmployeeInput } from "@/lib/validation";

/**
 * Authorization is the one part of this app where a silent regression is a
 * breach rather than a bug, so the matrix is asserted exhaustively rather than
 * spot-checked: every role against every permission, with the expected answer
 * written out. A permission added without a deliberate decision for each role
 * fails here.
 */

/** The intended matrix, transcribed independently of the implementation. */
const EXPECTED: Record<Permission, MemberRole[]> = {
  manage_ingredients: ["owner", "manager", "inventory", "kitchen"],
  manage_recipes: ["owner", "manager", "kitchen"],
  manage_suppliers: ["owner", "manager", "inventory"],
  manage_purchasing: ["owner", "manager", "inventory"],
  record_operations: ["owner", "manager", "inventory", "kitchen"],
  manage_stock_counts: ["owner", "manager", "inventory"],
  approve_stock_counts: ["owner", "manager"],
  // Sales are the revenue side of the books — narrower than record_operations
  // on purpose, and accountant stays read-only, which is enough to report on
  // sales without being able to alter them.
  manage_sales: ["owner", "manager"],
  manage_team: ["owner", "manager"],
  manage_settings: ["owner", "manager"],
  transfer_ownership: ["owner"],
};

describe("permission matrix", () => {
  it("covers every permission with an explicit expectation", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  for (const permission of Object.keys(EXPECTED) as Permission[]) {
    for (const role of MEMBER_ROLES) {
      const allowed = EXPECTED[permission].includes(role);
      it(`${role} ${allowed ? "may" : "may not"} ${permission}`, () => {
        expect(hasPermission(role, permission)).toBe(allowed);
      });
    }
  }
});

describe("role reach", () => {
  it("owner can do everything", () => {
    for (const permission of PERMISSIONS) expect(hasPermission("owner", permission)).toBe(true);
  });

  it("owner is the only role that can transfer ownership", () => {
    const holders = MEMBER_ROLES.filter(role => hasPermission(role, "transfer_ownership"));
    expect(holders).toEqual(["owner"]);
  });

  it("manager runs operations but cannot transfer ownership", () => {
    expect(hasPermission("manager", "manage_team")).toBe(true);
    expect(hasPermission("manager", "manage_settings")).toBe(true);
    expect(hasPermission("manager", "approve_stock_counts")).toBe(true);
    expect(hasPermission("manager", "transfer_ownership")).toBe(false);
  });

  it("inventory manages stock but not people", () => {
    expect(hasPermission("inventory", "manage_purchasing")).toBe(true);
    expect(hasPermission("inventory", "manage_suppliers")).toBe(true);
    expect(hasPermission("inventory", "manage_stock_counts")).toBe(true);
    expect(hasPermission("inventory", "manage_team")).toBe(false);
    expect(hasPermission("inventory", "manage_settings")).toBe(false);
    expect(hasPermission("inventory", "manage_sales")).toBe(false);
    // Submitting a count is not approving one.
    expect(hasPermission("inventory", "approve_stock_counts")).toBe(false);
  });

  it("kitchen and accountant cannot touch sales", () => {
    expect(hasPermission("kitchen", "manage_sales")).toBe(false);
    expect(hasPermission("accountant", "manage_sales")).toBe(false);
    // …but the accountant can still read them: reading stays open to every member.
  });

  it("kitchen cannot touch suppliers, purchasing or approvals", () => {
    expect(hasPermission("kitchen", "manage_recipes")).toBe(true);
    expect(hasPermission("kitchen", "record_operations")).toBe(true);
    expect(hasPermission("kitchen", "manage_suppliers")).toBe(false);
    expect(hasPermission("kitchen", "manage_purchasing")).toBe(false);
    expect(hasPermission("kitchen", "approve_stock_counts")).toBe(false);
    expect(hasPermission("kitchen", "manage_team")).toBe(false);
  });

  it("accountant holds no write permission at all", () => {
    for (const permission of PERMISSIONS) expect(hasPermission("accountant", permission)).toBe(false);
  });
});

describe("requirePermission / requireRole", () => {
  it("throws for a role without the permission", () => {
    expect(() => requirePermission("kitchen", "manage_suppliers")).toThrow(/does not allow/i);
    expect(() => requirePermission("accountant", "record_operations")).toThrow(/does not allow/i);
  });

  it("passes for a role that holds it", () => {
    expect(() => requirePermission("inventory", "manage_purchasing")).not.toThrow();
  });

  it("requireRole accepts a single role or a list", () => {
    expect(() => requireRole("owner", "owner")).not.toThrow();
    expect(() => requireRole("manager", ["owner", "manager"])).not.toThrow();
    expect(() => requireRole("kitchen", ["owner", "manager"])).toThrow(/does not allow/i);
  });
});

describe("viewer is retired", () => {
  it("is absent from the active roles", () => {
    expect(MEMBER_ROLES).not.toContain("viewer" as MemberRole);
    expect(isMemberRole("viewer")).toBe(false);
  });

  it("a legacy viewer row degrades to accountant, not to a write role", () => {
    const role = normalizeRole("viewer");
    expect(role).toBe("accountant");
    for (const permission of PERMISSIONS) expect(hasPermission(role, permission)).toBe(false);
  });

  it("unknown or malformed roles fail closed", () => {
    for (const value of ["", "superuser", "OWNER", "admin"]) {
      const role = normalizeRole(value);
      expect(hasPermission(role, "manage_team")).toBe(false);
    }
  });

  it("known roles pass through unchanged", () => {
    for (const role of MEMBER_ROLES) expect(normalizeRole(role)).toBe(role);
  });
});

describe("privilege escalation guards", () => {
  it("owner cannot be granted by invitation", () => {
    expect(INVITABLE_ROLES).not.toContain("owner" as MemberRole);
    expect(invitableRole.safeParse("owner").success).toBe(false);
    for (const role of INVITABLE_ROLES) expect(invitableRole.safeParse(role).success).toBe(true);
  });

  it("an invite payload asking for owner is rejected by validation", () => {
    const result = inviteEmployeeInput.safeParse({ email: "x@example.com", role: "owner" });
    expect(result.success).toBe(false);
  });

  it("nobody may act on their own membership", () => {
    expect(() => assertNotSelf("user-1", "user-1")).toThrow();
    expect(() => assertNotSelf("user-1", "user-2")).not.toThrow();
  });

  it("emails are lowercased so casing cannot create a duplicate invitation", () => {
    const parsed = inviteEmployeeInput.parse({ email: "  Rayen@Example.COM ", role: "kitchen" });
    expect(parsed.email).toBe("rayen@example.com");
  });
});

describe("location access", () => {
  it("owner, manager and accountant span every location", () => {
    expect(canAccessAllLocations("owner")).toBe(true);
    expect(canAccessAllLocations("manager")).toBe(true);
    expect(canAccessAllLocations("accountant")).toBe(true);
  });

  it("inventory and kitchen are pinned to their assigned site", () => {
    expect(canAccessAllLocations("inventory")).toBe(false);
    expect(canAccessAllLocations("kitchen")).toBe(false);
  });
});

describe("invitation tokens", () => {
  it("issues unguessable, unique tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createInvitationToken()));
    expect(tokens.size).toBe(200);
    // 32 bytes base64url — comfortably beyond brute force.
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it("stores only a hash, and the hash does not reveal the token", () => {
    const token = createInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    expect(hashInvitationToken(token)).toBe(hash);
    expect(hashInvitationToken(createInvitationToken())).not.toBe(hash);
  });

  it("compares hashes safely", () => {
    const hash = hashInvitationToken("a");
    expect(tokenHashEquals(hash, hash)).toBe(true);
    expect(tokenHashEquals(hash, hashInvitationToken("b"))).toBe(false);
    expect(tokenHashEquals(hash, "short")).toBe(false);
  });

  it("expires seven days out", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(invitationExpiry(from).toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("invitation redemption", () => {
  const base = { status: "pending", expiresAt: new Date("2026-01-08T00:00:00.000Z"), email: "invitee@example.com", role: "kitchen" };
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("accepts a pending, unexpired invitation for the matching address", () => {
    expect(checkInvitationRedeemable(base, "invitee@example.com", now)).toBeNull();
  });

  it("ignores casing and surrounding whitespace on the address", () => {
    expect(checkInvitationRedeemable(base, "  Invitee@Example.com ", now)).toBeNull();
  });

  it("rejects a missing invitation", () => {
    expect(checkInvitationRedeemable(null, "invitee@example.com", now)).toBe("not_found");
  });

  it("rejects revoked and already-accepted invitations", () => {
    expect(checkInvitationRedeemable({ ...base, status: "revoked" }, "invitee@example.com", now)).toBe("revoked");
    expect(checkInvitationRedeemable({ ...base, status: "accepted" }, "invitee@example.com", now)).toBe("already_accepted");
  });

  it("rejects an expired invitation, including exactly at the boundary", () => {
    const after = new Date("2026-01-09T00:00:00.000Z");
    expect(checkInvitationRedeemable(base, "invitee@example.com", after)).toBe("expired");
    expect(checkInvitationRedeemable(base, "invitee@example.com", base.expiresAt)).toBe("expired");
  });

  it("rejects a forwarded link opened by someone else", () => {
    expect(checkInvitationRedeemable(base, "someone.else@example.com", now)).toBe("email_mismatch");
  });

  it("rejects a signed-out redeemer", () => {
    expect(checkInvitationRedeemable(base, null, now)).toBe("email_mismatch");
  });

  it("checks status and expiry before identity, so a dead link never reports a mismatch", () => {
    // Ordering matters: a revoked invitation should say so rather than leak
    // whether the reader guessed the right address.
    expect(checkInvitationRedeemable({ ...base, status: "revoked" }, "wrong@example.com", now)).toBe("revoked");
  });

  it("refuses to redeem a row that grants owner", () => {
    // Defence in depth against a row that should not exist. Validation rejects
    // `owner` on the way in and a CHECK constraint refuses it in the database, so
    // reaching this branch means one of those failed — and redemption is the step
    // that would turn the row into a real membership.
    expect(checkInvitationRedeemable({ ...base, role: "owner" }, "invitee@example.com", now)).toBe("role_not_invitable");
  });

  it("refuses to redeem a row that grants the retired viewer role", () => {
    expect(checkInvitationRedeemable({ ...base, role: "viewer" }, "invitee@example.com", now)).toBe("role_not_invitable");
  });

  it("refuses a role that is not a role at all", () => {
    for (const role of ["", "superuser", "OWNER", "admin"]) {
      expect(checkInvitationRedeemable({ ...base, role }, "invitee@example.com", now)).toBe("role_not_invitable");
    }
  });

  it("accepts every role an invitation is allowed to grant", () => {
    for (const role of INVITABLE_ROLES) {
      expect(checkInvitationRedeemable({ ...base, role }, "invitee@example.com", now)).toBeNull();
    }
  });

  it("checks identity before the role, so a stranger learns nothing about the invitation", () => {
    expect(checkInvitationRedeemable({ ...base, role: "owner" }, "someone.else@example.com", now)).toBe("email_mismatch");
  });

  it("has a message for every rejection reason", () => {
    // A missing entry would render `undefined` on the invitation screen.
    for (const reason of ["not_found", "revoked", "already_accepted", "expired", "email_mismatch", "role_not_invitable"] as const) {
      expect(INVITATION_REJECTION_MESSAGES[reason]).toBeTruthy();
    }
  });
});
