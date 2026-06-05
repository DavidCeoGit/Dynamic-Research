/**
 * /runs → / redirect.
 *
 * S60.2 — bare `/runs/` (no slug) had no route and Next.js 404'd.
 * The runs listing is the root page; redirect there.
 */

import { redirect } from "next/navigation";

export default function RunsIndex() {
  redirect("/");
}
