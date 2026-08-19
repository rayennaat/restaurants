import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { onboardingInput } from "@/lib/validation";

const baseInput = {
  organizationName: "BIG MO",
  currency: "TND" as const,
  locale: "fr-TN" as const,
};

describe("multi-location onboarding validation", () => {
  it("accepts and trims several unique locations", () => {
    const result = onboardingInput.parse({
      ...baseInput,
      locations: JSON.stringify([" La Marsa ", "Ariana", "Lac 2"]),
    });

    expect(result.locations).toEqual(["La Marsa", "Ariana", "Lac 2"]);
  });

  it("requires at least one location", () => {
    expect(onboardingInput.safeParse({ ...baseInput, locations: "[]" }).success).toBe(false);
  });

  it("rejects malformed location data", () => {
    for (const locations of ["", "La Marsa", "{}", "null"]) {
      expect(onboardingInput.safeParse({ ...baseInput, locations }).success).toBe(false);
    }
  });

  it("rejects duplicate names without regard to case or surrounding whitespace", () => {
    const result = onboardingInput.safeParse({
      ...baseInput,
      locations: JSON.stringify(["La Marsa", " la marsa "]),
    });

    expect(result.success).toBe(false);
  });

  it("limits the number and length of locations", () => {
    expect(onboardingInput.safeParse({ ...baseInput, locations: JSON.stringify(Array.from({ length: 51 }, (_, index) => `Site ${index}`)) }).success).toBe(false);
    expect(onboardingInput.safeParse({ ...baseInput, locations: JSON.stringify(["x".repeat(121)]) }).success).toBe(false);
  });
});

describe("workspace creation persists the submitted location set atomically", () => {
  const source = readFileSync(path.join(process.cwd(), "src/server/actions/organization.ts"), "utf8");
  const start = source.indexOf("export async function createWorkspace");
  const end = source.indexOf("\nexport async function completeSetup", start);
  const action = source.slice(start, end);

  it("creates locations inside the workspace transaction", () => {
    expect(action).toContain("db.transaction(async tx");
    expect(action).toContain("input.locations[0]");
    expect(action).toContain("input.locations.slice(1)");
    expect(action).toContain("tx.insert(locations)");
  });

  it("uses the first submitted location as the owner's default", () => {
    expect(action).toContain("defaultLocationId: defaultLocation.id");
  });

  it("records the location count in the transaction-bound audit", () => {
    expect(action).toContain("locationCount: input.locations.length");
    expect(action).toMatch(/recordAudit\([\s\S]*?\btx\b[\s\S]*?\)/);
  });
});
