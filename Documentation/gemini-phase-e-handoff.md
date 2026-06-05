# Gemini Phase E Handoff — Frontend Assessment & Enhancement

## Mission

Review the Dynamic Research frontend implementation across all completed phases. Assess what additional frontend work is needed — UX improvements, missing features, polish, edge cases, responsive issues, accessibility gaps, or integration holes. Then implement your recommended enhancements as "Phase E."

You have full authority to determine what Phase E should contain based on your assessment.

---

## Project Overview

**Dynamic Research** is a web dashboard for managing AI-powered research pipelines. Users submit research topics through a multi-step wizard, a worker daemon processes them via Claude CLI, and results (audio, video, slides, reports, infographics) are stored in Supabase and displayed in a gallery.

- **Production URL:** https://dynamic-research.vercel.app
- **GitHub:** DavidCeoGit/Dynamic-Research
- **Stack:** Next.js 16, React 19, Tailwind CSS v4, SWR, lucide-react, Supabase (PostgreSQL + Storage)
- **Design system:** Dark theme — navy `#1a2744`, gold `#c8a951`, zinc grayscale, emerald success, red error

---

## What Has Been Built (Phases A–F)

### Phase A — Foundation (DB, types, validation)
- `lib/types/queue.ts` — Full TypeScript interfaces: `ResearchJob`, `SelectedProducts`, `VendorEvaluation`, `UserContext`, `Customizations`, `FormStep`, `GeneratedQuestion`
- `lib/validate.ts` — Zod schemas for all payloads: `researchJobPayloadSchema`, `generateQuestionsSchema`, `questionsResponseSchema`, `agentUpdateSchema`, `formDataSchema`, `FORM_DEFAULT_VALUES`
- `lib/estimates.ts` — `estimateMinutes()` function (per-product time estimates) and `phaseFromProgress()` mapping
- `lib/supabase.ts` — Singleton Supabase client (service role key, no auth persistence)
- `lib/storage.ts` — Supabase Storage helpers (signed URLs, file listing)
- `lib/files.ts` — File type detection and categorization

### Phase B — API Routes (5 endpoints)
- `POST /api/queue` — Create research job (validates payload, generates slug, calculates estimate)
- `GET /api/queue/[id]` — Poll job status (public, no auth)
- `PATCH /api/queue/[id]` — Update job progress (requires `X-Agent-Key` auth header)
- `POST /api/queue/claim` — Atomic job claiming for worker daemon (auth required, `FOR UPDATE SKIP LOCKED`)
- `POST /api/queue/generate-questions` — AI question generation via Claude Sonnet 4 (returns 5-7 contextual questions)

### Phase C — Form Wizard (multi-step UI, 14 files)
- `app/new/page.tsx` — Wizard shell with `FormProvider`
- `hooks/useNewResearchForm.ts` — Full wizard state: step navigation, AI question generation, dynamic answers, session storage persistence, typed form submission
- 7 components in `components/new-research/`:
  - `FormStepper.tsx` — Step indicator bar (Topic → Questions → Products → Customize → Review)
  - `StepTopic.tsx` — Topic input with 10-char minimum validation
  - `StepQuestions.tsx` — AI-generated refinement questions with Skip button fallback
  - `StepProducts.tsx` — Product selection checkboxes (audio, video, slides, report, infographic) with time estimates
  - `StepCustomize.tsx` — Perplexity/NotebookLM/Studio customization fields
  - `StepReview.tsx` — Final review with all selections summarized, submit button
  - `Shared.tsx` — Reusable components (TimeEstimate badge)
- Form validation: react-hook-form + @hookform/resolvers + Zod
- Session storage: drafts persist across page reloads

### Phase D — Progress Page (two-column dashboard)
- `app/new/[id]/page.tsx` — Full progress tracking page:
  - Two-column responsive grid (timeline left, dashboard right, stacks on mobile)
  - Left: 8-phase vertical timeline with per-phase icons, emerald/gold/zinc color states, dynamic vendor phase insertion
  - Right: Stats grid (progress %, elapsed time, ETA countdown, current phase), deliverables checklist per selected product, success/error panels
  - Live elapsed time counter (ticks every second from `claimed_at`)
  - Auto-redirect on completion (3s countdown → results page)
  - Error state with retry button (re-POSTs original payload) and "Edit Configuration" link
  - SWR polling every 3 seconds, stops on terminal state

### Phase E — Home Page Integration
- `app/page.tsx` — Run index with gold "New Research" CTA in empty state
- `app/layout.tsx` — Gold "New Research" button in header

### Phase F — Worker Daemon (Node.js, separate from frontend)
- `agent/` directory — Standalone Node.js process: polls queue, claims jobs, spawns Claude CLI, monitors `state.json`, uploads outputs to Supabase Storage
- Not part of the frontend — included for context only

---

## Existing Frontend Files (36 total)

```
app/
  layout.tsx                          — Root layout, header with nav
  page.tsx                            — Home/run index
  new/page.tsx                        — Form wizard shell
  new/[id]/page.tsx                   — Progress tracking page
  runs/[slug]/page.tsx                — Run detail view
  runs/[slug]/gallery/page.tsx        — Media gallery (audio, video, slides, images, markdown)
  api/queue/route.ts                  — POST create job
  api/queue/[id]/route.ts             — GET/PATCH job status
  api/queue/claim/route.ts            — POST claim job (worker auth)
  api/queue/generate-questions/route.ts — POST AI questions
  api/runs/route.ts                   — GET list runs
  api/runs/[slug]/files/route.ts      — GET list run files
  api/runs/[slug]/file/[filename]/route.ts — GET signed URL for file
  api/state/route.ts                  — GET pipeline state

components/
  AudioPlayer.tsx                     — Audio playback component
  CIScoreChart.tsx                    — CI score visualization
  MarkdownViewer.tsx                  — Markdown rendering with @tailwindcss/typography
  PDFViewer.tsx                       — PDF/PPTX viewer
  PhaseTimeline.tsx                   — Phase timeline (used in run detail)
  VendorTabs.tsx                      — Vendor evaluation tabs
  new-research/FormStepper.tsx        — Wizard step indicator
  new-research/Shared.tsx             — Shared form components
  new-research/StepTopic.tsx          — Step 1: Topic
  new-research/StepQuestions.tsx      — Step 2: AI Questions
  new-research/StepProducts.tsx       — Step 3: Products
  new-research/StepCustomize.tsx      — Step 4: Customize
  new-research/StepReview.tsx         — Step 5: Review

hooks/
  useRunState.ts                      — SWR hook for run state
  useNewResearchForm.ts               — Wizard form state management

lib/
  estimates.ts                        — Time estimation + phase mapping
  files.ts                            — File type utilities
  storage.ts                          — Supabase Storage helpers
  supabase.ts                         — Supabase client singleton
  validate.ts                         — Zod schemas + slug generation
  types/queue.ts                      — TypeScript interfaces
  parsers/markdown.ts                 — Markdown parsing utilities
```

---

## Design Constraints

- **Colors:** Navy `#1a2744` (header), Gold `#c8a951` (accent/CTA), Zinc grayscale (backgrounds/text), Emerald (success), Red (error)
- **Cards:** `rounded-lg border border-zinc-800 bg-zinc-900/50 p-5`
- **Buttons:** Gold CTA: `bg-[#c8a951] text-[#1a2744] hover:bg-[#d4b85e]`, Secondary: `border border-zinc-700 text-zinc-300 hover:bg-zinc-800`
- **Typography:** `text-2xl font-semibold tracking-tight text-zinc-100` (titles), `text-xs text-zinc-500` (labels), `font-mono` (IDs/timestamps)
- **Animations available:** `animate-in`, `fade-in`, `zoom-in`, `duration-500`, `animate-pulse`, `animate-spin`, `animate-pulse-slow` (custom gold pulse)
- **No new dependencies** unless strongly justified
- **Zero `as any` casts** — all types are properly defined

---

## Known Issues / Gaps (starting points for your assessment)

1. **No loading skeletons** — pages show spinner only, no content placeholders
2. **No toast/notification system** — retry failures silently catch errors
3. **Home page doesn't show queued/running jobs** — only completed runs appear in the index
4. **No mobile nav** — header may need hamburger menu at small screens
5. **Wizard has no "back to edit" from progress page** — once submitted, can't modify and resubmit (only full retry)
6. **Gallery page** — may need responsive improvements for different media types
7. **No error boundaries** — React error boundaries not implemented
8. **SEO/metadata** — no page-level metadata or Open Graph tags
9. **Accessibility** — no ARIA labels, focus management, or keyboard navigation audit done

---

## How to Work

1. Clone the repo: `git clone https://github.com/DavidCeoGit/Dynamic-Research.git`
2. `cd Dynamic-Research && pnpm install`
3. Copy `.env.local.example` to `.env.local` and fill in Supabase credentials
4. `pnpm dev` — runs on http://localhost:3000
5. Test against production API data — completed runs and queue jobs exist in Supabase
6. Make your changes, ensure `pnpm build` passes with zero errors
7. Commit with descriptive message and push to `main`

---

## Deliverable

Implement your recommended Phase E enhancements. Prioritize changes that have the highest user impact. Commit with a clear summary of what you changed and why.
