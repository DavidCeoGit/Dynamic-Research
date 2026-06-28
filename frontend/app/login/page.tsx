/**
 * Login page (Server Component).
 *
 * S181 — OTP-code login fix. The interactive two-step form is now the client
 * component <LoginForm>; this server page only resolves the safe redirect from
 * the query string and surfaces any ?error= bounced back by the magic-link
 * callback fallback (e.g. missing_code, no_user_after_exchange, membership
 * lookup failures). isSafeRedirect() narrows ?redirect= to same-origin relative
 * paths (open-redirect close-out) before it is handed to the client.
 */

import { isSafeRedirect } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const params = await searchParams;
  const safeRedirect = isSafeRedirect(params.redirect) ? params.redirect : "/";

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
      <LoginForm safeRedirect={safeRedirect} initialError={params.error} />
    </main>
  );
}
