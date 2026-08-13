/**
 * Errors whose message is written *for the user*.
 *
 * The authorization guards, the tenancy checks and the domain rules all throw a
 * sentence somebody should read: "Your role does not allow this action.", "Not
 * enough stock at the source." A driver error, a bug or a `TypeError` carries
 * something else entirely — a query fragment, a host, a file path — and must
 * never reach a browser.
 *
 * Nothing in the type of a thrown value distinguishes those two cases, so the
 * intentional ones are marked. This class is that mark: throwing it asserts
 * "this text is safe to show". `toActionError` returns the message of an
 * `ActionError` and replaces the message of anything else with a generic
 * sentence plus a log reference.
 *
 * It lives in its own dependency-free module because both the pure policy layer
 * (`lib/permissions`) and the server layer throw it, and pure code must stay
 * importable from tests without dragging in the server.
 */
export class ActionError extends Error {
  readonly fieldErrors?: Record<string, string>;

  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "ActionError";
    this.fieldErrors = fieldErrors;
  }
}

/** Whether a thrown value carries a message that is safe to show a user. */
export function isActionError(error: unknown): error is ActionError {
  return error instanceof ActionError;
}
