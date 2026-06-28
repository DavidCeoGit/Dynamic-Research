/**
 * Shared types for the login flow's useActionState server actions.
 *
 * Extracted out of actions.ts (a "use server" module) so they are NOT part of
 * the server-action export surface: a "use server" file may only export async
 * functions, and although type-only exports are erased by the compiler, a future
 * non-`type` import of these would break the bundler. Owning them here removes
 * that footgun (Gemini S181 MERGE-gate INFO #4).
 */
export interface SendState {
  ok: boolean;
  error: string | null;
}

export interface VerifyState {
  error: string | null;
}
