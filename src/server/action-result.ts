import { ZodError } from "zod";

/**
 * Uniform return shape for every server action so client forms can render
 * validation errors inline instead of throwing to the error boundary.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export function actionOk(): ActionResult<undefined>;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

export function actionError(error: string, fieldErrors?: Record<string, string>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const UNIQUE_MESSAGES: Record<string, { field: string; message: string }> = {
  ingredients_org_name_uidx: { field: "name", message: "An ingredient with this name already exists." },
  suppliers_org_name_uidx: { field: "name", message: "A supplier with this name already exists." },
  recipes_org_name_uidx: { field: "name", message: "A recipe with this name already exists." },
  units_org_code_uidx: { field: "code", message: "This unit code is already defined." },
  supplier_products_supplier_ingredient_uidx: { field: "ingredientId", message: "This supplier already sells this ingredient." },
  organizations_slug_uidx: { field: "organizationName", message: "That workspace name is taken." },
};

/**
 * Converts thrown errors into an {@link ActionResult}. Database constraint
 * violations become field-level messages rather than opaque 500s.
 */
export function toActionError(error: unknown): ActionResult<never> {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const path = issue.path.join(".");
      if (path && !fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return actionError(error.issues[0]?.message ?? "Check the highlighted fields.", fieldErrors);
  }

  const code = (error as { code?: string } | null)?.code;
  if (code === UNIQUE_VIOLATION) {
    const constraint = String((error as { constraint_name?: string; constraint?: string }).constraint_name ?? (error as { constraint?: string }).constraint ?? "");
    const known = UNIQUE_MESSAGES[constraint];
    if (known) return actionError(known.message, { [known.field]: known.message });
    return actionError("That record already exists.");
  }
  if (code === FOREIGN_KEY_VIOLATION) {
    return actionError("This record is still referenced by other data and cannot be removed.");
  }

  console.error("server action failed", error);
  return actionError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
}
