export const FAL_BILLING_URL = "https://fal.ai/dashboard/billing";

/** Machine-readable code returned by the dev token route when fal reports an exhausted balance. */
export const FAL_BALANCE_EXHAUSTED_CODE = "fal_balance_exhausted";

/** Session error code emitted by the browser transport for the same condition. */
export const FAL_BALANCE_EXHAUSTED_SESSION_CODE = "FAL_BALANCE_EXHAUSTED";

export const FAL_BALANCE_EXHAUSTED_MESSAGE =
  `Your fal.ai balance is exhausted. Top up at ${FAL_BILLING_URL}, then retry voice.`;

/**
 * fal locks the account with `403 {"detail":"User is locked. Reason: Exhausted balance. ..."}`
 * when credits run out. The key is still valid, so this is distinct from a 401.
 */
export function isFalBalanceExhausted(status: number, detail: string | undefined): boolean {
  return status === 403 && /exhausted balance|user is locked/i.test(detail ?? "");
}
