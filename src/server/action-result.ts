import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { ActionError } from "@/lib/action-error";

export { ActionError };

/**
 * Uniform return shape for every server action so client forms can render
 * validation errors inline instead of throwing to the error boundary.
 */
/**
 * The failure half of {@link ActionResult}, named so the helpers that only ever
 * produce a failure can say so in their return type. Route handlers need that:
 * they read `.error` off the result to build a JSON body, which a union type
 * cannot offer without a narrowing check that could never fail.
 */
export type ActionFailure = { ok: false; error: string; fieldErrors?: Record<string, string> };

export type ActionResult<T = undefined> = { ok: true; data: T } | ActionFailure;

/**
 * Errors whose message is written *for the user* and is safe to return.
 *
 * See {@link ActionError} in `lib/action-error` — re-exported above so server
 * code keeps importing the action vocabulary from one module.
 */
export function actionOk(): ActionResult<undefined>;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

export function actionError(error: string, fieldErrors?: Record<string, string>): ActionFailure {
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
 *
 * ## Why the first line is a rethrow
 *
 * `requireTenant()` signals "not signed in" by calling `redirect()`, and Next
 * implements `redirect()` by *throwing*. Every action in this codebase calls it
 * inside the same `try` that ends here, so without this rethrow the framework's
 * control flow was being caught and converted into `{ok: false, error:
 * "NEXT_REDIRECT"}` — the navigation never happened, and a signed-out user got
 * the string "NEXT_REDIRECT" in a form field. `unstable_rethrow` is Next's
 * supported way to say "not mine", and covers `notFound()` and the dynamic-
 * rendering bail-outs for the same reason.
 *
 * ## Why unrecognized errors lose their message
 *
 * A message is only returned when something deliberately wrote it for a user —
 * a Zod issue, a mapped constraint violation, or an {@link ActionError}. Anything
 * else is a bug or an infrastructure failure whose message may quote SQL, a
 * host, or a path; it is logged with a correlation id and the caller gets that
 * id instead, which is enough to find the log without disclosing its contents.
 */
export function toActionError(error: unknown): ActionFailure {
  // Framework control flow (redirect / notFound / dynamic bail-out). Must
  // continue to propagate or the navigation is silently cancelled.
  unstable_rethrow(error);

  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const path = issue.path.join(".");
      if (path && !fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return actionError(error.issues[0]?.message ?? "Check the highlighted fields.", fieldErrors);
  }

  // Explicitly user-facing: the thrower marked this text as safe to show.
  if (error instanceof ActionError) {
    return actionError(error.message, error.fieldErrors);
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

  // Unrecognized: log the detail where only operators can read it, and hand the
  // user a reference rather than the exception text.
  const reference = randomUUID().slice(0, 8);
  console.error(`server action failed [${reference}]`, error);
  return actionError(`Something went wrong. Please try again. (reference ${reference})`);
}
