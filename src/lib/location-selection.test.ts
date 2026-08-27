import { describe, expect, it } from "vitest";
import { defaultLocationId } from "@/lib/location-selection";

describe("write-form location defaults", () => {
  it("keeps an explicitly selected location", () => {
    expect(defaultLocationId("la-marsa", [{ id: "ariana" }, { id: "la-marsa" }])).toBe("la-marsa");
  });

  it("pins a form with one permitted location", () => {
    expect(defaultLocationId(null, [{ id: "la-marsa" }])).toBe("la-marsa");
  });

  it("leaves multi-location forms blank until the operator chooses", () => {
    expect(defaultLocationId(null, [{ id: "ariana" }, { id: "la-marsa" }])).toBe("");
    expect(defaultLocationId(null, [])).toBe("");
  });
});
