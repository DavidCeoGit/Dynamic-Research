/**
 * Authenticated-but-no-membership landing page.
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * Reached when /auth/callback exchanges a code successfully but the user has
 * no organization_members row. This is the "you authenticated, but the owner
 * has not provisioned your membership yet" landing.
 */

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

async function signOut(): Promise<never> {
  "use server";
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}

export default function NoOrgPage() {
  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold mb-4">Account not provisioned</h1>
      <p className="text-gray-700 mb-6">
        Your account is signed in but not yet associated with an organization.
        Contact the workspace owner to be invited.
      </p>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded border border-gray-300 px-4 py-2 text-sm"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
