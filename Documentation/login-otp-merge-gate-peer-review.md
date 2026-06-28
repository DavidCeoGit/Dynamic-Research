# S181 — Login OTP-code fix — tri-vendor SECURITY MERGE-gate peer review

**Gate:** MERGE · **Risk labels:** SECURITY (auth boundary, tenant isolation), AGENT BEHAVIOR (n/a — frontend only) · **Severity:** NORMAL · **Topology:** sequential Gemini (holistic-adversarial) → integrate → Codex gpt-5.5 xhigh (grounded-adversarial) → integrate → fresh Claude grounded subagent → integrate → final. UNANIMOUS ENDORSE required to merge.

**Change:** Add a passwordless 6-digit email-OTP login path beside the kept magic-link/`/auth/callback` path (which Gmail link-prefetch breaks). Shared post-auth router so the two paths cannot drift. Files: NEW `frontend/lib/post-auth.ts`, `frontend/app/login/login-form.tsx`, `frontend/app/login/types.ts`, `frontend/lib/__tests__/post-auth.test.ts`; MOD `frontend/app/login/actions.ts`, `frontend/app/login/page.tsx`, `frontend/app/auth/callback/route.ts`, `frontend/lib/rate-limit.ts`, `package.json`.

**Baseline:** `tsc --noEmit` clean both tiers; `pnpm test` = 663 agent + 142 frontend (was 134; +8 new), 0 fail. Frontend-only → worker/DR-Deploy untouched; Vercel builds `frontend/` on push.

## What each reviewer saw
- **Gemini 3.1-pro-preview (holistic-adversarial, BREADTH):** the full change summary + the complete 8-file diff (new files in full) + `supabase-server.ts` + `route-protection.ts` + `auth.ts`. No live repo execution.
- **Codex gpt-5.5 xhigh (grounded-adversarial, DEPTH, run-banner asserted: `model: gpt-5.5`, `reasoning effort: xhigh`, workspace-write, correct workdir):** read the live repo files + `@supabase/auth-js` source + `git show HEAD:` for the callback before-version + Gemini's findings + the author's refutations; ran counterexamples. _(verdict below)_
- **Claude grounded subagent (fresh, zero authoring context):** _(verdict below)_

---

## Round 1 — Gemini holistic-adversarial → VERDICT: BLOCK

Gemini raised 2 substantive findings (1 CRITICAL, 1 MAJOR) + 2 INFO. **Both substantive findings were investigated and REFUTED with ground-truth evidence**; the 2 INFO items were integrated. Gemini conceded claims 1,3,4,5,6,7 of the author's security posture (enumeration, open-redirect, no-PII, session, no-self-signup, drift-safety all hold).

### #1 CRITICAL (Gemini) — "verifyOtp type:'email' is wrong → total lockout" → **REFUTED**
Gemini asserted that `signInWithOtp({emailRedirectTo})` makes GoTrue tag the token `magiclink`, so `verifyOtp({type:'email'})` would "universally reject every valid code," and the fix was `type:'magiclink'`.

**Refutation (live test against PROD GoTrue `mfjgoghlpqgxcycxoxio`):** `admin.generateLink({type:'magiclink'})` (the admin equivalent of the magic-link send) returns `properties.email_otp`; verifying that code with `verifyOtp({email, token, type:'email'})` **SUCCEEDED (session=true)** under BOTH `flowType:'implicit'` AND `flowType:'pkce'` (production uses `@supabase/ssr` PKCE). It also succeeds with `type:'magiclink'`. So the magic-link-family OTP verifies as `'email'`; the code is correct and works under the production flow. Test script: `c:/tmp/dr-s181/review/otp-type-test.mjs`. **No code change.** (This is a textbook "holistic reviewer confidently wrong about an external-service mechanism" — the gate's verify-don't-integrate discipline avoided an unnecessary, itself-risky switch.)

### #2 MAJOR (Gemini) — "leftmost x-forwarded-for is spoofable on Vercel" → **REFUTED**
Gemini claimed an attacker can send `XFF: victim-ip`, Vercel appends the real IP to the right, so the leftmost (used by `clientIpFromHeaders`) is attacker-controlled → brute-force bypass + victim lockout; fix = use `x-real-ip`.

**Refutation (Vercel official docs — vercel.com/docs/headers/request-headers):** Vercel **OVERWRITES** `x-forwarded-for` with the true client IP and **does NOT forward client-supplied values**, explicitly "to prevent IP spoofing." So the leftmost entry IS the trusted, non-spoofable client IP on Vercel. Conversely `x-real-ip` is **not** a Vercel-managed header → Gemini's suggested fix is the *weaker* choice. The existing leftmost-XFF logic is correct; kept as-is. Comments clarified that `x-real-ip` is a local/non-Vercel fallback only. **No behavior change.**

### #3 INFO (Gemini) — Supabase per-IP limits hit Vercel egress IPs → **integrated (reframe)**
Correct: server-side `verifyOtp` calls egress from Vercel's IPs, so Supabase's per-IP limit throttles Vercel, not an end user. Reframed the brute-force posture: PRIMARY control = Supabase **per-token** (single-use codes + expiry — single-use confirmed in the live test), the per-IP bucket is a SECONDARY speed-bump. Comments updated; recommend lowering dashboard OTP expiry ≤10 min. Residual DoS risk acceptable for a 2-user trial.

### #4 INFO (Gemini) — types exported from a "use server" file are fragile → **integrated (fixed)**
Moved `SendState`/`VerifyState` to NEW `frontend/app/login/types.ts`; `actions.ts` + `login-form.tsx` now `import type` them; `actions.ts` exports ONLY the two async actions.

**Gemini verbatim verdict:** `VERDICT: BLOCK` (on findings #1/#2, both since refuted by ground truth).

---

## Round 2 — Codex gpt-5.5 xhigh grounded-adversarial → VERDICT: ENDORSE

(Run-banner asserted: `model: gpt-5.5`, `reasoning effort: xhigh`, workspace-write, correct workdir. First run truncated at EXIT=127 from over-long file-echo output after completing the substantive checks; re-run with an output-discipline header completed clean, EXIT=0.)

8 grounded verification tasks, all **CONFIRMED** except #6 **PARTIAL** (an INFO):
1. **verifyOtp type — CONFIRMED.** auth-js `GoTrueClient.ts:2125-2131` (sign-in OTP + magic-link share one impl), `:2203` (`emailRedirectTo` is send-redirect only), `:2246/:2255` (email OTP verify uses `type:'email'`). Independently confirms the live-test refutation of Gemini #1.
2. **Callback behavior-preservation — CONFIRMED.** `git show HEAD:` vs new `route.ts:33-49` + `post-auth.ts:41-65` — taxonomy byte-preserved.
3. **Two-path non-divergence / tenant isolation — CONFIRMED.** Shared resolver; no-member→/no-org, DB-error→/login on both; `proxy.ts:141-157` + `auth.ts:59-82` re-gate independently.
4. **Redirect swallow + open redirect — CONFIRMED.** `redirect()` outside catch (`actions.ts:139-158`), typed `never`; `isSafeRedirect` re-applied at page/action/callback.
5. **Enumeration — CONFIRMED.** Send success-shaped except pre-Supabase config/format; verify generic message, raw detail server-side only.
6. **Rate-limit — PARTIAL (INFO, now fixed).** Code integrity + ordering (IP-keyed, before Supabase verify) + existing-caller-unaffected all CONFIRMED; flagged that the comment claiming `x-real-ip` is "not Vercel-managed" was inaccurate (Vercel docs: x-real-ip is identical to x-forwarded-for). **→ comment corrected (rate-limit.ts v3).** XFF-spoof concern still refuted.
7. **Next 16 / useActionState legality — CONFIRMED.** `actions.ts` exports only async actions; types imported type-only from `types.ts`; no token/code logging; no `?sent=1` consumer.
8. **Test faithfulness + latent-bug sweep — CONFIRMED.** Stub chain matches real calls; coverage adequate; ran `pnpm test` = 663 agent + 142 frontend pass. No latent blocker.

**CRITICAL/MAJOR: none. VERDICT: ENDORSE.**

---

## Round 3 — Claude grounded subagent (fresh, zero authoring context) → VERDICT: ENDORSE

All 7 items independently CONFIRMED (re-ran the live OTP test + `pnpm test` itself).
- #1 strengthened: auth-js `GoTrueClient.d.ts:1096-1107` documents **`'magiclink'` is DEPRECATED** for verifyOtp — so Gemini's suggested fix pointed at a deprecated type; `type:'email'` is correct. Live test confirmed under pkce.
- #2 refuted (Vercel overwrites XFF). #3 tenant isolation holds (3 independent layers). #4 redirect contained (18-vector adversarial probe all rejected/contained). #5 enumeration-safe. #6 rate-limit ordering verified (counts all attempts, IP-keyed). #7 latent sweep: partial-auth case (verify ok, routing throws) returns generic error WITHOUT redirect and **fails CLOSED** — benign degraded UX, session re-validated on next nav.
- **CRITICAL/MAJOR: none.** MINOR: LF-vs-CRLF promote note (cosmetic — independently verified non-issue: `git diff --stat` == `git diff --ignore-cr-at-eol --stat`, and new files are all-additions; git autocrlf stores LF). INFO: recommend dashboard OTP-expiry tightening.

**VERDICT: ENDORSE.**

---

## Round 4 — Gemini holistic reconsider (ground-truth QA) → VERDICT: ENDORSE

Given the live runtime test, auth-js vendor source, Vercel docs, and both other vendors' ENDORSE, Gemini reconsidered its v1 BLOCK:
- **Finding #1 (verifyOtp type): WITHDRAWN** — "vendor source code and live production testing conclusively demonstrate codes verify under `type:'email'`, and `type:'magiclink'` is deprecated."
- **Finding #2 (XFF spoof): WITHDRAWN** — "official Vercel docs confirm the platform overwrites `x-forwarded-for`, discarding client-spoofed headers; leftmost read is accurate and secure."
- "No new evidence-based security concerns." **VERDICT: ENDORSE.**

---

## Synthesis / disposition — UNANIMOUS ENDORSE → MERGE

All three vendors ENDORSE (Gemini after ground-truth reconsider; Codex + Claude on first pass). No standing CRITICAL/MAJOR finding. Both of Gemini's v1 blockers were factually refuted — not risk-accepted — by live runtime + vendor source + Vercel docs, each independently corroborated by the other two vendors. The "verify-don't-integrate" discipline avoided shipping Gemini's suggested `type:'magiclink'` (a deprecated type) and an unnecessary x-real-ip switch (the weaker source).

INFO items integrated (non-behavioral): types extracted from the `"use server"` module; brute-force framing corrected to per-token-primary; rate-limit x-real-ip comment corrected. Build: tsc clean both tiers, 663 agent + 142 frontend tests, 0 fail.

**Disposition: MERGE.** Frontend-only → Vercel auto-builds on push; worker/DR-Deploy untouched. Post-merge: recommend the user lower the Supabase dashboard OTP expiry to ≤10 min (shrinks the brute-force window; the per-token single-use control is primary).
