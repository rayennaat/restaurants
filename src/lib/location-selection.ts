export type PermittedLocation = { id: string };

/**
 * Chooses the initial location for a write form without inventing a branch.
 *
 * An explicitly resolved location is preserved. A member with exactly one
 * permitted location is pinned there. Multi-location operators start blank and
 * must choose the branch that will own the write.
 */
export function defaultLocationId(
  selectedLocationId: string | null,
  permittedLocations: PermittedLocation[],
): string {
  if (selectedLocationId) return selectedLocationId;
  return permittedLocations.length === 1 ? permittedLocations[0].id : "";
}
