"use client";

/**
 * Login form — passwordless two-step (Client Component).
 *
 * S181 — OTP-code login fix. Step 1 emails a 6-digit code (+ a magic-link
 * backup); step 2 reveals on the SAME page (React state, no navigation, no email
 * in the URL) to type the code. Each step is a separate <form> bound to its own
 * useActionState action so pending/error states are independent.
 *
 * The email is held in client state and submitted to BOTH actions (a hidden
 * field on step 2); both actions normalize (trim + lowercase) identically so the
 * verify email matches the send email. The `redirect` is passed through from the
 * server page (already isSafeRedirect-validated) and RE-validated server-side in
 * the action — a tampered hidden field cannot widen it.
 */

import { useActionState, useEffect, useRef, useState } from "react";
import { sendEmailOtp, verifyEmailOtp } from "./actions";
import type { SendState, VerifyState } from "./types";

const SEND_INIT: SendState = { ok: false, error: null };
const VERIFY_INIT: VerifyState = { error: null };

export function LoginForm({
  safeRedirect,
  initialError,
}: {
  safeRedirect: string;
  initialError?: string;
}) {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [sendState, sendAction, sendPending] = useActionState(sendEmailOtp, SEND_INIT);
  const [verifyState, verifyAction, verifyPending] = useActionState(
    verifyEmailOtp,
    VERIFY_INIT,
  );
  // Advance to the code step once per successful send. The ref guards against a
  // re-advance after the user clicks "Use a different email" (step is reset to
  // "email" while sendState is still ok); a fresh submit yields a NEW state
  // object, so reactedSend !== sendState and we advance again.
  const reactedSend = useRef<SendState | null>(null);
  useEffect(() => {
    if (sendState.ok && sendState !== reactedSend.current) {
      reactedSend.current = sendState;
      setStep("code");
    }
  }, [sendState]);

  if (step === "code") {
    return (
      <form action={verifyAction} className="space-y-4">
        <p className="text-sm text-gray-700">
          We emailed a 6-digit code to{" "}
          <span className="font-medium">{email}</span>. Enter it below. (A
          magic-link is also in that email as a backup.)
        </p>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="redirect" value={safeRedirect} />
        <label className="block">
          <span className="block text-sm font-medium mb-1">6-digit code</span>
          <input
            name="token"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            className="w-full rounded border border-gray-300 px-3 py-2 tracking-widest"
          />
        </label>
        <button
          type="submit"
          disabled={verifyPending}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {verifyPending ? "Verifying…" : "Verify code"}
        </button>
        {verifyState.error ? (
          <p className="text-sm text-red-600" role="alert">
            {verifyState.error}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => setStep("email")}
          className="text-sm text-gray-500 underline"
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form action={sendAction} className="space-y-4">
      <label className="block">
        <span className="block text-sm font-medium mb-1">Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>
      <input type="hidden" name="redirect" value={safeRedirect} />
      <button
        type="submit"
        disabled={sendPending}
        className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {sendPending ? "Sending…" : "Send code"}
      </button>
      {(sendState.error ?? initialError) ? (
        <p className="text-sm text-red-600" role="alert">
          {sendState.error ?? initialError}
        </p>
      ) : null}
    </form>
  );
}
