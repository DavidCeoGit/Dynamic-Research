# Dynamic Research — Team Review Briefing

**Live:** https://dynamic-research.vercel.app
**Date prepared:** 2026-05-24 (S51)
**Status:** Soft launch — please look, click, break, report back.

---

## 30-second elevator

Dynamic Research is a web app that turns any topic into a **three-way deep research deliverable**: Perplexity Pro, NotebookLM Ultra, and Claude all research the same question in parallel; a Confidence Index (CI) cross-filters the sources; then NotebookLM Studio produces audio, video, slides, an executive report, and an infographic from the surviving high-confidence material. You submit a topic via a 3-step form; a worker daemon spawns the full pipeline; deliverables land in a per-run gallery in 30-60 min at a cost of ~$1-3 per topic.

The interesting thing it does that off-the-shelf research tools don't: **CI-based source filtering** + **multi-modal Studio output bundled per topic**. The interesting thing under the hood: an LLM agent dynamically orchestrates a Claude CLI subprocess + Perplexity MCP + NotebookLM Python CLI + Chrome DevTools MCP, with full audit trail of every storage write.

---

## What to try (3 example runs)

| Slug | Topic | Why look here |
|---|---|---|
| **core-thesis-how-you-fund-a-major-purchas-52b8e5bd** | $50K Tesla case study showing $186K wealth swing from capital-structure choice | Most polished gallery — full audio + video + slides + report + infographic |
| **tesla-ce-3-studioonly-s42-acceptance-pos-46368af2** | Same topic, re-run in clone-and-edit mode | Demos the "regenerate Studio products against an existing parent run" path |
| **cam-ai-program-applications-in-the-quick-u9el** | Government contracting intelligence (ASC SDVOSB) | Demos vendor-evaluation + CI Tier-1 scoring flow |

URLs to open:

- Landing — https://dynamic-research.vercel.app
- Submit a topic — https://dynamic-research.vercel.app/new
- Best gallery — https://dynamic-research.vercel.app/runs/core-thesis-how-you-fund-a-major-purchas-52b8e5bd/gallery
- Latest progress view (active jobs) — https://dynamic-research.vercel.app

**To trigger a real run yourself:** open `/new`, paste any topic (~100-500 chars works best), step through the 3-step wizard, hit submit. You'll get a progress page that auto-updates. Expect 30-60 min wall clock. ~$1-3 in API spend lands on the operator's bill.

---

## What's worth giving feedback on

Highest-value feedback right now is on **content and UX**, not infrastructure. Specifically:

1. **Form wizard at `/new`** — is the 3-step flow (topic → context → product selection) clear? Anything ambiguous in the labels or examples?
2. **Gallery rendering** — open a polished run's gallery. Does each artifact (audio player, video player, slide deck, executive report, infographic) load cleanly? Anything that looks broken or out of place?
3. **Run progress page** — submit a test job (cheap topics are fine) and watch the progress UI. Is the phase progression clear? Any phase that feels stuck or confusing?
4. **Deliverable quality** — open one of the polished example galleries and check the actual research output: do the audio/video narrations sound right? Does the executive report read like a deliverable you'd hand to a client?
5. **Source citations + CI scoring** — every research-tier-1 source is listed with a confidence score. Is the scoring legible? Does the "why this source was kept/rejected" trail make sense?

## What to ignore (known WIP, already on the roadmap)

These items are already documented in the handoff + ~/CLAUDE.md and don't need flagging:

- **No login / no auth yet.** Single-tenant access via a shared URL. The multi-tenancy backend is live (RLS policies in place) but the SSR auth refactor that exposes login to users is the next major work item (~8-12h, queued for S52+).
- **`SYSTEM_DEFAULT_ORG_ID` env-var stopgap** in 2 frontend routes — retires when SSR auth ships.
- **Anyone with the URL can submit a job.** No rate limiting on `POST /api/queue` yet — this is a known cost-control gap (#1 finding in the 2026-05-24 health review).
- **No invite flow yet.** `agent/scripts/provision-beta-user.ts` is queued, not written.
- **Form wizard styling is functional, not pretty.** A polish pass is queued for after auth lands.
- **`/api/queue/extract-context` + `/api/queue/generate-questions` are unauth and uncapped.** Known cost exposure (#1 from the S51 health review). If you spam them I will see it on the Vercel logs and politely yell.

## What's RECENTLY shipped (last 2 weeks)

| Date | Item |
|---|---|
| 2026-05-24 (S50→S51) | Storage-path multi-tenancy refactor LIVE — all uploads now scope to `<orgId>/<slug>/<file>` + audit row per write |
| 2026-05-23 (S49) | Multi-tenancy Phase B-1 — 14 RLS policies, 4 private schema helpers, audit_storage_writes table, cardinality_violation fail-loud helper |
| 2026-05-22 (S47) | Multi-tenancy Phase A — `organization_id` columns, 1-org-per-user constraint, immutable-org-id trigger |
| 2026-05-17→22 (S44-S48) | Multi-reviewer policy framework v2.2 with sequential Gemini→Codex topology at every gate |
| 2026-04-16→24 (S25-S30) | ASC government-contracting intelligence (18 deliverables, 23 NLM Studio products) |

## 1-week roadmap (S52 → S55, ~2 weeks)

| When | Item | Effort |
|---|---|---|
| Next | Cost cap on 2 unauth Anthropic routes (`maxOutputTokens` + rate limit) | ~1h |
| Next | CVE sweep — bump `next` 16.2.3 → 16.2.6 (closes 14 CVEs), `marked`, `@supabase/supabase-js` | ~2h |
| Next | Add `<untrusted_input>` fence to `extract-context/route.ts` (SECURITY label MERGE-gate) | ~30min + review |
| Then | Cost telemetry — `research_usage` Supabase table populated per job complete | ~2h |
| Then | SSR auth refactor — `@supabase/ssr`, login page, magic-link callback, server-side session, retire stopgaps in 6 routes | ~8-12h |
| Then | Phase B-2 migration — DROP DEFAULT on `research_queue.organization_id` + explicit RLS ENABLE on 4 tenant tables | ~1h |
| Then | Invite flow — `agent/scripts/provision-beta-user.ts` + invite-acceptance UI | ~2-3h |
| Then | Legacy storage cleanup — `phase-b-cleanup-legacy-storage-paths.ts` (DELETE flat-path objects after 30-day soak ends 2026-06-23) | ~30min |

## How to send feedback

_(User to fill in — placeholder options: Slack channel `#dynamic-research-beta`, GitHub Issues at `DavidCeoGit/Dynamic-Research/issues`, or email to `ceo@thewcoachinggroup.com`)_

When reporting an issue, please include:
- URL you were on
- What you expected
- What happened
- (If applicable) browser + tab dev-tools console error

---

## For the curious — under-the-hood links

- Repo: `DavidCeoGit/Dynamic-Research` (push-clone deploy from local `frontend/`)
- Worker daemon: long-running Node process on the operator's machine; Scheduled Task supervises restarts; ~36h average uptime
- Stack: Next.js 16 + React 19 + Tailwind 4 + Supabase Postgres + Storage; agent runtime is Node 22 + tsx + `@supabase/supabase-js`; agentic loop is `claude -p` CLI with Perplexity MCP + Chrome DevTools MCP + WebSearch + WebFetch
- Multi-reviewer review process: every DESIGN/MERGE/AUDIT gate routes through sequential Gemini Deep Think → Codex GPT-5.5 xhigh peer review per the policy framework in `~/CLAUDE.md`
