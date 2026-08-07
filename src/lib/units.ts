/**
 * Unit handling for the inventory ledger.
 *
 * Every ingredient has a canonical `baseUnitCode`. Stock movements, minimum
 * stock and inventory balances are always expressed in that base unit, while
 * purchase and recipe lines may be captured in any compatible unit (grams for a
 * kilogram ingredient, millilitres for a litre ingredient, ...). Conversion
 * happens through the org-scoped `units` table.
 */

export type UnitRow = { code: string; name: string; dimension: string; multiplierToBase: string | number; isBase: boolean };

/** Units seeded for every new organization. Codes are stable identifiers. */
export const DEFAULT_UNITS: { code: string; name: string; dimension: string; multiplierToBase: string; isBase: boolean }[] = [
  { code: "kg", name: "Kilogram", dimension: "mass", multiplierToBase: "1", isBase: true },
  { code: "g", name: "Gram", dimension: "mass", multiplierToBase: "0.001", isBase: false },
  { code: "l", name: "Litre", dimension: "volume", multiplierToBase: "1", isBase: true },
  { code: "ml", name: "Millilitre", dimension: "volume", multiplierToBase: "0.001", isBase: false },
  { code: "cl", name: "Centilitre", dimension: "volume", multiplierToBase: "0.01", isBase: false },
  { code: "unit", name: "Unit", dimension: "count", multiplierToBase: "1", isBase: true },
  { code: "dozen", name: "Dozen", dimension: "count", multiplierToBase: "12", isBase: false },
];

export const UNIT_DIMENSIONS = ["mass", "volume", "count"] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

export function multiplierOf(unit: UnitRow | undefined) {
  const value = Number(unit?.multiplierToBase ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function findUnit(units: UnitRow[], code: string | null | undefined) {
  if (!code) return undefined;
  return units.find(unit => unit.code === code);
}

/**
 * Converts `quantity` expressed in `fromCode` into the ingredient's base unit.
 * Unknown or dimension-mismatched units fall back to a 1:1 conversion so a
 * missing units row can never silently zero out someone's inventory.
 */
export function toBaseQuantity(quantity: number, fromCode: string | null | undefined, baseCode: string, units: UnitRow[]) {
  if (!fromCode || fromCode === baseCode) return quantity;
  const from = findUnit(units, fromCode);
  const base = findUnit(units, baseCode);
  if (!from || !base || from.dimension !== base.dimension) return quantity;
  return (quantity * multiplierOf(from)) / multiplierOf(base);
}

/** Inverse of {@link toBaseQuantity}. */
export function fromBaseQuantity(baseQuantity: number, toCode: string | null | undefined, baseCode: string, units: UnitRow[]) {
  if (!toCode || toCode === baseCode) return baseQuantity;
  const to = findUnit(units, toCode);
  const base = findUnit(units, baseCode);
  if (!to || !base || to.dimension !== base.dimension) return baseQuantity;
  return (baseQuantity * multiplierOf(base)) / multiplierOf(to);
}

/**
 * Converts a per-unit price. A price of 18.500/kg becomes 0.0185/g, so the
 * factor is the inverse of the quantity conversion.
 */
export function toBaseUnitCost(unitCostMinor: number, fromCode: string | null | undefined, baseCode: string, units: UnitRow[]) {
  const oneFromUnitInBase = toBaseQuantity(1, fromCode, baseCode, units);
  if (!oneFromUnitInBase) return unitCostMinor;
  return unitCostMinor / oneFromUnitInBase;
}

/** Units the user may pick for an ingredient measured in `baseCode`. */
export function compatibleUnits(units: UnitRow[], baseCode: string) {
  const base = findUnit(units, baseCode);
  if (!base) return units.filter(unit => unit.code === baseCode);
  return units.filter(unit => unit.dimension === base.dimension);
}

export function formatQuantity(value: string | number, unit: string, maximumFractionDigits = 3) {
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits })} ${unit}`;
}
