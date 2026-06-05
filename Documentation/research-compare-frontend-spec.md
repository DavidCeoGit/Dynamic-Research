> ⚠️ **ARCHIVED 2026-05-25 (S52 #5).** This spec described the *pre-build* target as of Phase A: Next 14, no Supabase, auth=none, in-memory state. The live frontend has since moved to **Next 16, Supabase queue + storage with RLS (Phase B-1 helpers landed; B-2 RLS-enable pending), email magic-link auth, worker daemon**, and ships at https://dynamic-research.vercel.app. Do NOT use this document as a source of truth for reviews, architecture decisions, or onboarding. For current state see `~/.claude/projects/c--Users-ceo-Documents-AI-Training-Anti-Gravity-Dynamic-Research/memory/dryrun_handoff.md` + the codebase. Preserved verbatim below for the implementation-history record.

---

# Research Compare Frontend — Implementation Spec

> **Purpose:** Self-contained blueprint for Gemini to build a Next.js frontend for the `/research-compare` CLI workflow. All reference files are embedded as appendices — no filesystem access required to start building.

---

## 1. Project Overview

### What This Frontend Does

The `/research-compare` CLI command (~944 lines) orchestrates three-way deep research: **Perplexity Pro + NotebookLM Ultra + Claude Baseline** → CI-filtered analysis + NotebookLM Studio outputs (audio, video, slides, report, infographic) + optional vendor evaluation.

Currently this runs entirely in the CLI. This frontend provides:

1. **Dashboard** — manage all research runs, see status at a glance
2. **Real-time progress** — track active runs through 12 phases
3. **Output preview** — play audio/video, render markdown, view images/PDFs inline
4. **Source comparison** — side-by-side Perplexity vs NLM vs Claude baseline
5. **CI scoring visualization** — Tier 1 URL scores + Tier 2 claim scores as charts/tables
6. **Vendor evaluation dashboard** — pre-screening, shortlist, interview protocol, contract checklist
7. **Gallery** — browse Studio outputs with version comparison (v1 vs v2 vs v3)
8. **Session resume** — view in-progress and completed runs

### Architecture Principle

**The frontend is read-only.** The CLI (Claude Code + NotebookLM CLI + Perplexity) is the execution engine and sole writer. The frontend reads `state.json` files and output files from disk. It never writes, modifies, or triggers CLI operations.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14+ (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS 4+ |
| UI | Custom components only (no MUI, Chakra, or heavy UI libraries) |
| Markdown | `gray-matter` (frontmatter) + `marked` (rendering) |
| PDF | `react-pdf` (for slides — see Bug 23) |
| Audio | `wavesurfer.js` (waveform visualization) |
| Diff | `diff` / `jsdiff` (version comparison) |
| State | File-based (`state.json` per run) — no database |
| Auth | None (single-user local tool) |
| Package manager | pnpm |

### NPM Dependencies

```json
{
  "dependencies": {
    "next": "^14.2",
    "react": "^18.3",
    "react-dom": "^18.3",
    "tailwindcss": "^4",
    "gray-matter": "^4.0",
    "marked": "^12",
    "react-pdf": "^9",
    "wavesurfer.js": "^7",
    "diff": "^5"
  },
  "devDependencies": {
    "typescript": "^5.4",
    "@types/react": "^18",
    "@types/node": "^20"
  }
}
```

---

## 3. File Locations

The frontend reads from two directories per run:

| Directory | Purpose | Example |
|-----------|---------|---------|
| **Working dir** | Active runs with state.json + all outputs | `C:/tmp/research-compare/canyon-lake-plumber-bathtub-install/` |
| **Projects dir** | Final deliverables (copies + title-prefixed + .docx) | `C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects/canyon-lake-plumber-bathtub-install/` |

Configurable via `.env.local`:

```env
RESEARCH_WORKING_DIR=C:/tmp/research-compare
RESEARCH_PROJECTS_DIR=C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects
```

---

## 4. Routes (6 pages)

```
/                           — Dashboard: grid of all runs with status badges
/runs/[slug]                — Run detail: phase timeline + output summary
/runs/[slug]/compare        — Three-way source comparison (side-by-side)
/runs/[slug]/scoring        — CI scoring visualization (Tier 1 + Tier 2)
/runs/[slug]/vendors        — Vendor evaluation dashboard (conditional)
/runs/[slug]/gallery        — Studio outputs gallery with inline playback
```

---

## 5. API Layer (11 endpoints)

All endpoints are Next.js Route Handlers under `app/api/`. All read-only.

### 5.1 Run Discovery & State

```
GET /api/runs
```
Scans `RESEARCH_WORKING_DIR/*/` for `*-state.json` files. Returns `RunSummary[]`:

```typescript
interface RunSummary {
  slug: string;
  topic: string;
  timestamp: string;
  phase: string;
  phase_status: string;
  version: number;
  selectedProducts: Record<ProductType, boolean>;
  vendorEvaluationEnabled: boolean;
  fileCount: number;
}
```

```
GET /api/runs/[slug]
```
Reads the full `state.json` for this slug. Returns the complete `RunState` object plus computed fields:
- `fileInventory`: all files in working dir + projects dir with sizes and types
- `phaseTimeline`: derived phase completion status

```
GET /api/runs/[slug]/state
```
**Lightweight poll endpoint.** Returns only `{ phase, phase_status, version, artifacts }`. Used for real-time updates during active runs.

### 5.2 File Listing & Serving

```
GET /api/runs/[slug]/files
```
Lists all output files for this run with metadata:

```typescript
interface FileEntry {
  name: string;
  type: 'markdown' | 'audio' | 'video' | 'image' | 'slides' | 'state' | 'docx';
  size: number;
  version: number;
  productType?: ProductType;
  isTitlePrefixed: boolean;
  titlePrefixedName?: string;
  location: 'working' | 'projects';
}
```

```
GET /api/runs/[slug]/file/[filename]
```
Serves a file from the working directory. Sets correct `Content-Type` headers. **For large files (mp3, mp4): supports HTTP Range headers for streaming/seeking.** Never loads entire file into memory — uses `createReadStream`.

```
GET /api/runs/[slug]/file-projects/[filename]
```
Same as above but serves from the Projects directory (for title-prefixed copies and .docx files).

### 5.3 Structured Data Parsing

```
GET /api/runs/[slug]/markdown/[filename]
```
Reads a markdown file, parses YAML frontmatter with `gray-matter`, returns `{ raw: string, frontmatter: object }`.

```
GET /api/runs/[slug]/comparison-data
```
**Key value-add endpoint.** Parses `TIMESTAMP-comparison.md` into structured data:

```typescript
interface ComparisonData {
  executiveSummary: string;
  fullConsensus: Claim[];        // All three agree
  majorityFindings: Claim[];     // Two of three
  divergent: Divergence[];       // Disagreements
  uniqueInsights: {
    perplexity: string[];
    notebookLM: string[];
    claude: string[];
  };
  sourceQuality: Record<string, SourceQualityMetrics>;
  researchQuestions: ResearchQuestionCoverage[];
  metadata: ComparisonMetadata;
  appendixA: Claim[];            // Low-confidence claims (<80)
  appendixB: UrlScore[];         // Rejected Tier 1 URLs
}
```

```
GET /api/runs/[slug]/scoring-data
```
Returns structured CI scoring data combining state.json fields and parsed comparison.md:

```typescript
interface ScoringData {
  tier1: {
    passed: UrlScore[];
    rejected: UrlScore[];
    threshold: number;         // 60 (standard) or 50 (hyperlocal)
    maxScore: number;          // 75
  };
  tier2: {
    mainBody: Claim[];         // CI >= 80
    appendixA: Claim[];        // CI < 80
    threshold: number;         // 80
    maxScore: number;          // 100
    averageScore: number;
  };
  topicHalfLife: string;
}
```

```
GET /api/runs/[slug]/vendor-data
```
Parses `TIMESTAMP-vendor-evaluation.md` into structured data:

```typescript
interface VendorData {
  jobDescription: string;
  serviceArea: string;
  vendorType: string;
  preScreening: VendorPreScreen[];
  shortlisted: VendorDetail[];
  excluded: VendorExcluded[];
  prerequisites: PrerequisiteItem[];
  competencyMatrix: Competency[];
  interviewProtocol: InterviewQuestion[];
  contractChecklist: ContractItem[];
  dataGapWarnings: string[];
}
```

### 5.4 File Path Resolution

```typescript
// lib/paths.ts
import path from 'path';

const WORKING_DIR = process.env.RESEARCH_WORKING_DIR || 'C:/tmp/research-compare';
const PROJECTS_DIR = process.env.RESEARCH_PROJECTS_DIR ||
  'C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects';

export function resolveRunPaths(slug: string) {
  return {
    workingDir: path.resolve(WORKING_DIR, slug),
    projectsDir: path.resolve(PROJECTS_DIR, slug),
  };
}

export function findStateFile(dir: string): string | null {
  // Scan for *-state.json in dir, return first match
}
```

### 5.5 MIME Type Mapping

```typescript
const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.pptx': 'application/pdf',  // Bug 23: slides are actually PDFs
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.json': 'application/json',
};
```

### 5.6 File Streaming with Range Support

For audio (40-50 MB) and video (50-100 MB), the file endpoint must support HTTP Range headers:

```typescript
// app/api/runs/[slug]/file/[filename]/route.ts
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

export async function GET(req: Request, { params }: { params: { slug: string; filename: string } }) {
  const filePath = resolveFilePath(params.slug, params.filename);
  const fileStat = await stat(filePath);
  const range = req.headers.get('range');

  if (range) {
    const [startStr, endStr] = range.replace('bytes=', '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileStat.size - 1;
    const stream = createReadStream(filePath, { start, end });
    return new Response(stream as any, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': getMimeType(params.filename),
      },
    });
  }

  const stream = createReadStream(filePath);
  return new Response(stream as any, {
    headers: {
      'Content-Type': getMimeType(params.filename),
      'Content-Length': String(fileStat.size),
      'Accept-Ranges': 'bytes',
    },
  });
}
```

---

## 6. Component Architecture

### 6.1 Layout

```
RootLayout
├── Sidebar (dark navy — run list, quick-switch between runs)
├── TopBar (current run name, phase badge, version selector)
└── Main content area (route-dependent)
```

### 6.2 Dashboard Page (`/`)

```
RunsGrid
└── RunCard (per run)
    ├── Topic name
    ├── Timestamp + relative time ("2 hours ago")
    ├── Phase indicator (colored badge: green=complete, yellow=in-progress, red=error)
    ├── Version badge (v1, v2, v3)
    ├── Product icons (audio, video, slides, report, infographic — filled if generated)
    ├── Vendor badge (if vendorEvaluation.enabled)
    └── Quick stats: "3/11 URLs passed CI", "31 claims CI>=80"
```

### 6.3 Run Detail Page (`/runs/[slug]`)

```
RunHeader
├── Topic, timestamp, version
├── Phase progress stepper (horizontal — see 6.4)
└── Quick action buttons: Compare, Scoring, Vendors, Gallery

PhaseTimeline (see 6.4)

OutputSummary
└── Grid of OutputCards (one per file type)
    ├── Type icon
    ├── File size
    ├── Version
    └── "Preview" button → opens gallery focus view

RunMetadata (collapsible sections)
├── Notebook ID (copyable)
├── Products selected
├── Customizations summary
└── User context (domainKnowledge, constraints, etc.)
```

### 6.4 Phase Timeline Stepper

Horizontal stepper — the signature UX element. Shows all phases with color-coded status.

```typescript
// lib/constants.ts
export const PHASES = [
  { id: '0.5',   name: 'Discussion',  description: 'Interactive topic exploration',           icon: 'chat' },
  { id: 'gate1', name: 'Gate 1',      description: 'Customization approval',                  icon: 'diamond', isGate: true },
  { id: '0',     name: 'Preflight',   description: 'Auth, folders, notebook creation',         icon: 'setup' },
  { id: '1',     name: 'Research',    description: 'NLM Deep Research + Perplexity (parallel)', icon: 'search' },
  { id: '1.5',   name: 'CI Scoring',  description: 'Tier 1 URL confidence scoring',            icon: 'filter' },
  { id: '3',     name: 'Import',      description: 'Source import + dedup',                    icon: 'download' },
  { id: '4',     name: 'Extraction',  description: 'NLM text extraction',                     icon: 'document' },
  { id: '5',     name: 'Synthesis',   description: 'Three-way comparison + Tier 2 CI',         icon: 'merge' },
  { id: '5.5a',  name: 'Vendors',     description: 'Vendor discovery & evaluation',            icon: 'people',
    conditional: 'vendorEvaluation.enabled' },
  { id: 'gate2', name: 'Gate 2',      description: 'Studio customization approval',            icon: 'diamond', isGate: true },
  { id: '5.5',   name: 'Studio',      description: 'Parallel Studio generation',               icon: 'media',
    conditional: 'hasSelectedProducts' },
  { id: '6',     name: 'Final',       description: 'Save, rename, convert',                   icon: 'check' },
];
```

**Phase state mapping:**
- Completed phases: **gold** background
- Current phase: **azure** background with pulse animation
- Future phases: **navy** outline only
- Gates: diamond shapes instead of circles
- Conditional phases (5.5a, 5.5): shown only when applicable, grayed out otherwise

### 6.5 Comparison Page (`/runs/[slug]/compare`)

```
ComparisonLayout
├── SourceSelector (toggle P / N / C visibility)
│
├── ThreeColumnView
│   ├── SourceColumn (Perplexity)
│   │   ├── Rendered TIMESTAMP-perplexity.md
│   │   ├── Word count badge
│   │   └── Source type badge ("WebSearch fallback" or "Perplexity MCP")
│   ├── SourceColumn (NotebookLM)
│   │   ├── Rendered TIMESTAMP-notebooklm.md
│   │   ├── Char count badge
│   │   └── Source count badge
│   └── SourceColumn (Claude Baseline)
│       ├── Baseline claims from brief (Section 5: Baseline Knowledge Snapshot)
│       └── Claim count badge
│
├── ConsensusPanel
│   ├── Full Consensus table (all three agree) with CI scores
│   ├── Majority Findings (two of three) with divergence callouts
│   └── Unique Insights per source (expandable)
│
└── ClaimDetailModal (on click)
    ├── Full claim text
    ├── Per-dimension CI scores (5 horizontal bars)
    │   ├── Source Credibility (/30)
    │   ├── Author Credibility (/25)
    │   ├── Currency (/20)
    │   ├── Corroboration (/15)
    │   └── Internal Consistency (/10)
    ├── Source attribution with links
    └── Main body vs. Appendix A indicator
```

### 6.6 CI Scoring Page (`/runs/[slug]/scoring`)

```
ScoringDashboard
├── Tier1Section
│   ├── Tier1Summary
│   │   ├── "3 passed / 8 rejected" with pass rate %
│   │   ├── Threshold indicator (>=60/75 standard, >=50/75 hyperlocal)
│   │   └── Topic half-life badge
│   ├── Tier1BarChart
│   │   ├── Horizontal bars sorted by score
│   │   ├── Green (passed) / Red (rejected) coloring
│   │   └── Threshold line overlay
│   └── Tier1UrlTable (sortable)
│       ├── Domain | Score (/75) | Pass/Fail | Reason
│       └── Expandable row: per-dimension breakdown
│
└── Tier2Section
    ├── Tier2Summary
    │   ├── "N claims >=80 (main body) / M claims <80 (Appendix A)"
    │   └── Average CI score
    ├── Tier2Histogram
    │   ├── Score distribution (bins: 60-69, 70-79, 80-89, 90-100)
    │   └── Threshold line at 80
    └── Tier2ClaimTable (sortable, filterable)
        ├── Claim | Sources (P/N/C badges) | CI Score | Dimensions
        └── Filters: Main Body / Appendix A / All + Source filter
```

### 6.7 Vendor Dashboard (`/runs/[slug]/vendors`)

```
VendorDashboard
├── VendorHeader
│   ├── Job description, service area, vendor type
│   └── Discovery stats: "13 discovered, 4 shortlisted, 9 excluded"
│
├── PreScreeningTable
│   ├── All discovered vendors with Pass/Fail + reason
│   ├── Sortable by rating, distance, license status
│   └── Color coding: green=PASS, red=EXCLUDED, yellow=VERIFY
│
├── ShortlistCards (3-5 finalist cards)
│   └── VendorCard
│       ├── Name, location, distance
│       ├── Rating + review count (stars)
│       ├── License status (verified / unverified)
│       ├── Key strengths
│       ├── [ ! ] VERIFY ON CALL flags (amber)
│       └── Phone link (tel:)
│
└── EvaluationFramework (4 tabs)
    ├── PrerequisitesTab — printable pass/fail checklist
    ├── MatrixTab — weighted competency grid (1-5 scoring columns)
    ├── InterviewTab — accordion Q&A with target answers + red flags
    └── ContractTab — SOW line items checklist
```

### 6.8 Gallery Page (`/runs/[slug]/gallery`)

```
GalleryGrid
├── OutputCard (per product, per version)
│   ├── Thumbnail/icon for type
│   ├── Title (from title-prefixed filename, or product type)
│   ├── Version badge
│   ├── File size
│   ├── Quick play button (audio/video only)
│   └── Click → focus view
│
└── VersionCompare
    ├── Side-by-side or tabbed v1 vs v2 vs v3
    ├── Markdown (report): diff view with green/red highlighting
    ├── Images (infographic): side-by-side with slider
    └── Audio: dual player with synced playback

FocusView (inline or modal for each output type)
├── VersionSelector dropdown (v1, v2, v3)
│
├── MarkdownViewer (brief, perplexity, notebooklm, comparison, vendor-eval, report)
│   ├── Rendered HTML with Tailwind prose class
│   ├── Table of contents sidebar (from headings)
│   └── YAML frontmatter as metadata card
│
├── AudioPlayer (.mp3)
│   ├── Waveform visualization (wavesurfer.js)
│   ├── Play/pause, seek, speed (0.5x, 1x, 1.5x, 2x)
│   ├── Duration display
│   └── Download button
│
├── VideoPlayer (.mp4)
│   ├── HTML5 video with controls
│   ├── Fullscreen support
│   └── Download button
│
├── ImageViewer (.png infographic)
│   ├── Full-resolution zoomable
│   └── Download button
│
└── SlideViewer (.pptx / .pdf)
    ├── PDF renderer (react-pdf) — Bug 23: slides ARE PDFs
    ├── Page navigation (prev/next, page numbers)
    ├── Fullscreen presentation mode
    └── Download both .pptx and .pdf versions
```

---

## 7. Real-Time Progress Updates

### Strategy: Polling state.json

The CLI writes `state.json` at every checkpoint. The frontend polls the lightweight `/api/runs/[slug]/state` endpoint. No SSE or WebSocket needed.

```typescript
// hooks/useRunState.ts
import { useState, useEffect } from 'react';

export function useRunState(slug: string) {
  const [state, setState] = useState<RunState | null>(null);

  useEffect(() => {
    const poll = async () => {
      const res = await fetch(`/api/runs/${slug}/state`);
      const data = await res.json();
      setState(data);
    };

    poll(); // initial fetch

    // Poll every 5 seconds while run is active
    if (state?.phase_status !== 'complete' && state?.phase_status !== 'aborted_by_user') {
      const interval = setInterval(poll, 5000);
      return () => clearInterval(interval);
    }
  }, [slug, state?.phase_status]);

  return state;
}
```

### Artifact-Level Progress

During Phase 5.5, each artifact transitions through states:

```
generating → polling → completed | failed | timeout
```

The `artifacts` field in state.json tracks this per product. The gallery should show individual progress indicators for each product card.

---

## 8. TypeScript Interfaces

```typescript
// types/run.ts

type ProductType = 'audio' | 'video' | 'slides' | 'report' | 'infographic';

interface RunState {
  timestamp: string;                    // "20260414-062922"
  topic: string;
  topic_slug: string;
  phase: string;                        // "0.5"|"0"|"1"|"1.5"|"3"|"4"|"5"|"5.5a"|"5.5"|"6"
  phase_status: string;                 // "initialized"|"complete"|"both_researching"|"aborted_by_user"|etc.
  notebook_id: string | null;
  notebook_title: string | null;
  version: number;
  projects_path: string | null;
  perplexity_mcp_available: boolean;
  perplexity_source_urls_passed: string[];
  perplexity_source_urls_rejected: string[];
  tier1_scores: Record<string, number>; // domain → score
  aji_dna_enabled: boolean;
  persona_configured: boolean;
  topic_half_life: string | null;
  auth_verified_at: string | null;
  queued_urls_for_notebooklm: string[];
  userContext: UserContext;
  selectedProducts: Record<ProductType, boolean>;
  customizations: Customizations;
  vendorEvaluation: VendorEvaluation;
  artifacts: Record<string, ArtifactState>;
  files_written: string[];
}

interface UserContext {
  contextFilePath: string | null;
  additionalUrls: string[];
  claimsToVerify: string[];
  domainKnowledge: string[];
  constraints: string[];
  localSourcePath: string | null;
}

interface ArtifactState {
  task_id: string;
  status: 'generating' | 'polling' | 'completed' | 'failed' | 'timeout';
  version: number;
  format?: string;
  alternate_tasks?: string[];
}

interface Customizations {
  perplexity: {
    queryFraming: string;
    emphasis: string[];
    outputStructure: string;
  };
  notebookLM: {
    persona: string;
    researchMode: 'deep' | 'standard';
    priorities: string[];
  };
  studio: {
    audio: { tone: string; format: string; hostStyle: string; customInstructions?: string };
    video: { style: string; format: string; narratorTone: string; visualEmphasis: string; customInstructions?: string };
    slides: { layout: string; keyPointsPerSlide: number; customInstructions?: string };
    report: { format: string; sectionStructure: string[]; depth: string; customInstructions?: string };
    infographic: { orientation: string; keyStats: string[]; customInstructions?: string };
  };
}

interface VendorEvaluation {
  enabled: boolean;
  vendorType: string;
  serviceArea: string;
  serviceAddress: string;
  jobDescription: string;
  maxVendorsDiscovered: number;
  maxVendorsEnriched: number;
  vendorsDiscovered: string[];
  vendorsShortlisted: string[];
  vendorsExcluded: string[];
  preScreeningComplete: boolean;
}

interface Claim {
  id: number;
  text: string;
  sources: string[];            // ["P", "N", "C"]
  ciScore: number;
  dimensions?: {
    sourceCredibility: number;   // /30
    authorCredibility: number;   // /25
    currency: number;            // /20
    corroboration: number;       // /15
    internalConsistency: number; // /10
  };
}

interface UrlScore {
  domain: string;
  url: string;
  score: number;
  passed: boolean;
  reason?: string;
}

// Vendor-specific types
interface VendorPreScreen {
  name: string;
  location: string;
  distance: string;
  rating: number;
  reviews: number;
  licenseVerified: boolean | null;  // null = unverifiable
  passed: boolean;
  reason: string;
  verifyFlags: string[];            // ["VERIFY ON CALL", "MANUAL LICENSE CHECK"]
}

interface VendorDetail extends VendorPreScreen {
  phone: string;
  website: string;
  specialties: string[];
  strengths: string[];
  enrichmentNotes: string;
}

interface InterviewQuestion {
  id: number;
  competencyArea: string;
  question: string;
  targetAnswer: string;         // Score 5 response
  redFlag: string;              // Score 1 response
}

interface Competency {
  name: string;
  description: string;
  weight: number;               // percentage
  scoringScale: string;         // 1-5 description
}

interface ContractItem {
  item: string;
  requirement: string;
  checked: boolean;             // visual only, not interactive
}

interface PrerequisiteItem {
  requirement: string;
  standard: string;
  verification: string;
  checked: boolean;             // visual only
}
```

---

## 9. Markdown Parsing

### 9.1 Frontmatter

Use `gray-matter` to split YAML frontmatter from body:

```typescript
import matter from 'gray-matter';
const { data: frontmatter, content: body } = matter(rawMarkdown);
```

### 9.2 Comparison File Parser

The comparison.md follows a strict section structure. Parse with regex:

```typescript
// lib/parsers/comparison.ts

// Extract sections by heading pattern
const sections = body.split(/^# \d+\.\s+/gm);

// Parse consensus/majority tables — format:
// | # | Claim | Sources | CI Score |
// |---|-------|---------|----------|
// | 1 | Texas law requires... | P, N, C | **95** |
const TABLE_ROW = /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*([PNC,\s+]+)\s*\|\s*\*\*(\d+)\*\*\s*\|$/gm;

// Extract CI scores from bold numbers
const CI_SCORE = /\*\*(\d+)\*\*/;

// Extract source attributions
const SOURCES = /([PNC])/g;
```

### 9.3 Vendor Evaluation Parser

Parse the vendor-evaluation.md sections:

```typescript
// lib/parsers/vendor.ts

// Pre-screening table: pipe-delimited rows
// Phase 1 prerequisites: [ ] pattern
const PREREQ = /\[ \]\s*(.+?):\s*(.+?)\.\s*Verification:\s*(.+)/;

// Interview Q&A: structured blocks
// Contract items: [ ] pattern
const CONTRACT = /\[ \]\s*(.+?):\s*(.+)/;
```

---

## 10. File Naming Conventions

### Research Files (NOT versioned, NOT title-prefixed)

```
TIMESTAMP-brief.md
TIMESTAMP-perplexity.md
TIMESTAMP-notebooklm.md
TIMESTAMP-comparison.md
TIMESTAMP-vendor-evaluation.md
TIMESTAMP-context.md
TIMESTAMP-state.json
```

### Studio Output Files (versioned + title-prefixed)

```
Base naming:     TIMESTAMP-product[-vN].ext     (v1 = no suffix)
Title-prefixed:  Title-Slug-TIMESTAMP-product[-vN].ext
```

Examples:
```
20260414-062922-audio-v3.mp3
Safe-plumbing-for-heavy-upstairs-bathtubs-20260414-062922-audio-v3.mp3
```

### Parsing Regex

```typescript
// Timestamped files
const TIMESTAMPED = /^(\d{8}-\d{6})-(\w[\w-]*?)(?:-v(\d+))?\.(\w+)$/;

// Title-prefixed files
const TITLE_PREFIXED = /^(.+)-(\d{8}-\d{6})-(\w[\w-]*?)(?:-v(\d+))?\.(\w+)$/;
```

### Version Grouping

Group files by product type and version for the gallery:

```typescript
interface VersionedOutput {
  productType: ProductType;
  versions: {
    version: number;
    files: FileEntry[];  // timestamp + title-prefixed copies
  }[];
}
```

---

## 11. Visual Design

### Brand: "Secure Regenerative AI"

```
Primary:    Deep Navy    #1A2744  — authority, trust
Secondary:  Clean White  #FFFFFF  — clarity
Accent:     Warm Gold    #C8A951  — success, premium
Technology: Azure Blue   #3B82F6  — innovation
Background: Silver Gray  #F8FAFC  — professional neutrality
Alert:      Deep Red     #B91C1C  — sparingly
```

### Tailwind Config

```javascript
// tailwind.config.ts
theme: {
  extend: {
    colors: {
      navy: '#1A2744',
      gold: '#C8A951',
      azure: '#3B82F6',
      silver: '#F8FAFC',
    },
    fontFamily: {
      heading: ['Montserrat', 'sans-serif'],
      body: ['Inter', 'sans-serif'],
    },
  },
}
```

### UI Principles

- Dark sidebar (navy), light content area (silver/white)
- Phase stepper: azure = current, gold = complete, navy outline = pending
- Gates: diamond shapes, not circles
- Data-dense tables with generous row spacing
- Source badges: **P** (azure), **N** (gold), **C** (navy)
- CI scores: color gradient from red (<60) through yellow (60-79) to green (>=80)
- Clean geometric layouts, generous whitespace

---

## 12. Product Type Constants

```typescript
// lib/constants.ts
export const PRODUCT_TYPES = {
  audio:       { icon: 'headphones', label: 'Audio',       color: 'azure', ext: '.mp3',  cliType: 'audio',       mimeType: 'audio/mpeg' },
  video:       { icon: 'film',       label: 'Video',       color: 'gold',  ext: '.mp4',  cliType: 'video',       mimeType: 'video/mp4' },
  slides:      { icon: 'presentation', label: 'Slides',    color: 'navy',  ext: '.pptx', cliType: 'slide-deck',  mimeType: 'application/pdf' },
  report:      { icon: 'document',   label: 'Report',      color: 'navy',  ext: '.md',   cliType: 'report',      mimeType: 'text/markdown' },
  infographic: { icon: 'image',      label: 'Infographic', color: 'gold',  ext: '.png',  cliType: 'infographic', mimeType: 'image/png' },
} as const;
```

**Note:** CLI type for slides is `slide-deck` (not `slides`). The state key remains `slides`.

---

## 13. File Structure

```
frontend/
├── app/
│   ├── layout.tsx                          Root layout (sidebar + topbar)
│   ├── page.tsx                            Dashboard (runs grid)
│   ├── runs/
│   │   └── [slug]/
│   │       ├── page.tsx                    Run detail (phase timeline)
│   │       ├── compare/page.tsx            Three-way comparison
│   │       ├── scoring/page.tsx            CI scoring dashboard
│   │       ├── vendors/page.tsx            Vendor evaluation
│   │       └── gallery/page.tsx            Studio gallery
│   └── api/
│       └── runs/
│           ├── route.ts                    GET /api/runs
│           └── [slug]/
│               ├── route.ts               GET /api/runs/[slug]
│               ├── state/route.ts          GET .../state (poll)
│               ├── files/route.ts          GET .../files
│               ├── file/[filename]/route.ts         Streaming file serve
│               ├── file-projects/[filename]/route.ts  Projects dir serve
│               ├── markdown/[filename]/route.ts     Parsed markdown
│               ├── comparison-data/route.ts         Structured comparison
│               ├── scoring-data/route.ts            Structured CI scores
│               └── vendor-data/route.ts             Structured vendor data
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx
│   │   └── TopBar.tsx
│   ├── dashboard/
│   │   ├── RunCard.tsx
│   │   └── RunsGrid.tsx
│   ├── run/
│   │   ├── PhaseTimeline.tsx
│   │   ├── PhaseStep.tsx
│   │   ├── OutputSummary.tsx
│   │   ├── OutputCard.tsx
│   │   └── RunMetadata.tsx
│   ├── compare/
│   │   ├── ThreeColumnView.tsx
│   │   ├── SourceColumn.tsx
│   │   ├── ConsensusPanel.tsx
│   │   └── ClaimDetailModal.tsx
│   ├── scoring/
│   │   ├── Tier1Section.tsx
│   │   ├── Tier1UrlTable.tsx
│   │   ├── Tier1BarChart.tsx
│   │   ├── Tier2Section.tsx
│   │   ├── Tier2ClaimTable.tsx
│   │   └── Tier2Histogram.tsx
│   ├── vendors/
│   │   ├── PreScreeningTable.tsx
│   │   ├── ShortlistCards.tsx
│   │   ├── VendorCard.tsx
│   │   ├── EvaluationFramework.tsx
│   │   ├── PrerequisitesTab.tsx
│   │   ├── MatrixTab.tsx
│   │   ├── InterviewTab.tsx
│   │   └── ContractTab.tsx
│   ├── gallery/
│   │   ├── GalleryGrid.tsx
│   │   └── VersionCompare.tsx
│   ├── viewers/
│   │   ├── MarkdownViewer.tsx
│   │   ├── AudioPlayer.tsx
│   │   ├── VideoPlayer.tsx
│   │   ├── ImageViewer.tsx
│   │   └── SlideViewer.tsx
│   └── shared/
│       ├── Badge.tsx
│       ├── ProgressBar.tsx
│       ├── ScoreBar.tsx                    Reusable horizontal score bar
│       ├── SourceBadge.tsx                 P / N / C colored badges
│       └── VersionSelector.tsx
├── hooks/
│   ├── useRunState.ts                      Polling hook
│   ├── useMarkdown.ts                      Fetch + render markdown
│   └── useFileUrl.ts                       Construct streaming URLs
├── lib/
│   ├── paths.ts                            File path resolution
│   ├── mime.ts                             MIME type lookup
│   ├── constants.ts                        Phases, product types, colors
│   └── parsers/
│       ├── comparison.ts                   Parse comparison.md
│       ├── vendor.ts                       Parse vendor-evaluation.md
│       ├── scoring.ts                      Extract CI data
│       └── files.ts                        Group by type/version
├── types/
│   └── run.ts                              All TypeScript interfaces
├── tailwind.config.ts
├── next.config.mjs
├── tsconfig.json
└── package.json
```

---

## 14. Critical Implementation Notes

### 14.1 Windows Paths
All file I/O uses `path.resolve()` and `path.join()`. Windows handles both forward and backslashes. The working directory `C:/tmp/research-compare/` uses forward slashes in config but Node.js on Windows handles both.

### 14.2 Slides Are PDFs (Bug 23)
NLM `slide-deck` download produces PDF files with `.pptx` extension. The SlideViewer must **always use PDF rendering** (`react-pdf`), regardless of file extension. Both `.pptx` and `.pdf` versions exist in the Projects folder.

### 14.3 Large File Streaming
Audio (40-50 MB) and video (50-100 MB) must use `createReadStream` with Range headers. Never use `readFile` for media. This enables seeking in the audio/video player without downloading the entire file.

### 14.4 Graceful Handling of Incomplete Runs
A run aborted at Phase 3 has brief.md, perplexity.md, and state.json but no comparison, vendor-evaluation, or Studio outputs. The UI must:
- Show "Not yet generated" placeholders for missing outputs
- Dim/disable nav links to pages that have no data (e.g., no comparison = dim "Compare" link)
- Never error on missing files — check existence before rendering

### 14.5 Backward Compatibility
Old state files may be missing `version` and `projects_path` fields. Default: `version: 1`, `projects_path: null` (infer from working directory).

### 14.6 Known Bugs Affecting Frontend

| Bug | Impact | Frontend Handling |
|-----|--------|------------------|
| **Bug 23** | Slides output PDF with .pptx extension | Always use PDF renderer for slides |
| **Bug 12** | Download creates backslash-path on Windows | API layer normalizes all paths |
| **Bug 26** | `artifact list` crashes on emoji in titles | Don't call `artifact list` — use state.json |

---

## 15. Build & Run

```bash
cd frontend
pnpm install
pnpm dev        # Development: http://localhost:3000
pnpm build      # Production build
pnpm start      # Production server
```

Works immediately after `pnpm dev` with zero configuration (reads from hardcoded default paths). Override paths via `.env.local`.

---

## 16. Verification Checklist

1. `pnpm build` completes without errors
2. **Dashboard (`/`):** Shows Canyon Lake run — phase 6/complete, version 3, all 5 product icons filled
3. **Phase timeline (`/runs/canyon-lake-plumber-bathtub-install`):** All 12 phases green (complete)
4. **Comparison (`/runs/.../compare`):** Perplexity, NLM, baseline columns render with word/char counts
5. **CI scoring (`/runs/.../scoring`):** Tier 1 bar chart (3 passed / 8 rejected, threshold 60/75), Tier 2 claim table
6. **Vendors (`/runs/.../vendors`):** 13 discovered, 4 shortlisted, 9 excluded, pre-screening table, interview questions
7. **Gallery (`/runs/.../gallery`):** All 5 products with v1/v2/v3 versions, audio plays, video plays, slides render as PDF
8. **File streaming:** Audio/video support seeking without full download
9. **Incomplete run:** Create a state.json with `phase: "3"` — phases 4+ show as pending, no errors

---

## 17. Test Fixtures

The Canyon Lake project folder is a complete reference implementation:

**Working dir:** `C:/tmp/research-compare/canyon-lake-plumber-bathtub-install/`
**Projects dir:** `C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects/canyon-lake-plumber-bathtub-install/`

Contains: state.json (v3, all fields), 4 research markdown files, vendor evaluation, all 5 Studio outputs at v1/v2/v3, title-prefixed copies, .docx conversions, .pdf slide copies.

---

# APPENDICES — Reference Files (Embedded Verbatim)

---

## Appendix A: research-compare.md — CLI Workflow Summary

> The full 944-line CLI workflow file is at `~/.claude/commands/research-compare.md`. Below is the complete state file format and phase structure that the frontend must understand. For the full file contents, provide this spec to Gemini along with the file itself.

### State File Format (complete schema with defaults)

```json
{
  "timestamp": "TIMESTAMP",
  "topic": "$ARGUMENTS",
  "topic_slug": "TOPIC_SLUG",
  "version": 1,
  "phase": "0",
  "phase_status": "initialized",
  "notebook_id": null,
  "notebook_title": null,
  "projects_path": null,
  "perplexity_mcp_available": false,
  "perplexity_source_urls_passed": [],
  "perplexity_source_urls_rejected": [],
  "tier1_scores": {},
  "aji_dna_enabled": false,
  "persona_configured": false,
  "topic_half_life": null,
  "auth_verified_at": null,
  "queued_urls_for_notebooklm": [],
  "userContext": {
    "contextFilePath": null,
    "additionalUrls": [],
    "claimsToVerify": [],
    "domainKnowledge": [],
    "constraints": [],
    "localSourcePath": null
  },
  "selectedProducts": {
    "audio": false, "video": false, "slides": false, "report": false, "infographic": false
  },
  "customizations": { "perplexity": {}, "notebookLM": {}, "studio": {} },
  "vendorEvaluation": {
    "enabled": false, "vendorType": "", "serviceArea": "", "serviceAddress": "",
    "jobDescription": "", "maxVendorsDiscovered": 10, "maxVendorsEnriched": 5,
    "vendorsDiscovered": [], "vendorsShortlisted": [], "vendorsExcluded": [],
    "preScreeningComplete": false
  },
  "artifacts": {},
  "files_written": []
}
```

### Phase Progression and State Updates

| Phase | State `phase` | State `phase_status` | Files Created |
|-------|--------------|---------------------|---------------|
| 0.5 Discussion | "0.5" | varies | (in-memory) |
| Gate 1 | "0.5" | approved/aborted | — |
| 0 Preflight | "0" | "initialized" | TIMESTAMP-brief.md |
| 1+2 Research | "1" | "both_researching" | TIMESTAMP-perplexity.md |
| 1.5 CI Scoring | "1.5" | varies | — (URLs scored in state) |
| 3 Import | "3" | "notebooklm_complete" | — |
| 4 Extraction | "4" | varies | TIMESTAMP-notebooklm.md |
| 5 Synthesis | "5" | "complete" | TIMESTAMP-comparison.md |
| 5.5a Vendors | "5.5a" | varies | TIMESTAMP-vendor-evaluation.md |
| Gate 2 | "5.5a" | approved/aborted | — |
| 5.5 Studio | "5.5" | varies | TIMESTAMP-product[-vN].ext |
| 6 Final | "6" | "complete" | (copies + renames) |

### Comparison File Structure (Phase 5 output — 11 sections)

```
1. Executive Summary (200-250 words)
2. Full Consensus (all three agree) — claims with CI scores
3. Majority Findings (two of three) — with divergence notes
4. Divergent Perspectives — per-divergence breakdown
5. Unique Insights per Source — P-only, N-only, C-only
6. Source Quality Assessment — comparison table
7. Research Question Coverage — matrix
8. Recommended Further Research — 3-5 gaps
9. Metadata — topic, half-life, word counts
Appendix A — Low-confidence claims (CI <80)
Appendix B — Rejected Tier 1 URLs
```

### Studio Generation Details

| Product | CLI Type | Format Flag | Timeout | Extension |
|---------|----------|-------------|---------|-----------|
| Audio | `audio` | `--format deep-dive` | 45 min | .mp3 |
| Video | `video` | `--format cinematic` | 45 min | .mp4 |
| Slides | `slide-deck` | `--format presenter` | 20 min | .pptx (actually PDF) |
| Report | `report` | (positional arg) | 20 min | .md |
| Infographic | `infographic` | `--orientation portrait` | 20 min | .png |

### Error Handling Reference (26 bugs)

| Bug | Issue | Frontend Impact |
|-----|-------|-----------------|
| 8 | `research wait --import-all` crashes | Long Phase 3 (plan 15+ min) |
| 11 | `notebooklm create` doesn't auto-switch | Phase 0 sequencing |
| 12 | Download creates backslash-path | API normalizes paths |
| 18 | Python `/c/` paths fail | Internal to scripts |
| 20 | Tasks stuck without 5s jitter | Phase 5.5 sequential launch |
| 23 | Slides output PDF as .pptx | Always use PDF renderer |
| 25 | `--instructions` flag doesn't exist | Phase 5.5 instruction building |
| 26 | `artifact list` crashes on emoji (cp1252) | Use state.json, not CLI |

---

## Appendix B: state.json (Canyon Lake — Complete Reference)

> The actual production state from a completed v3 run. Every field populated with real values.

```json
{
  "timestamp": "20260414-062922",
  "topic": "Canyon Lake TX plumber bathtub install",
  "topic_slug": "canyon-lake-plumber-bathtub-install",
  "phase": "6",
  "phase_status": "complete",
  "notebook_id": "8ec6310f-36a2-4739-8096-468567424549",
  "notebook_title": "Research: Canyon Lake TX Plumber Bathtub Install",
  "perplexity_mcp_available": false,
  "scratch_tab_id": null,
  "perplexity_source_urls_passed": [
    "https://www.tdlr.texas.gov/ab/ppt/2024/part-4-plumbing.pdf",
    "https://www.sll.texas.gov/law-legislation/texas/building-codes/plumbing-codes/",
    "https://up.codes/viewer/texas/irc-2015/chapter/27/plumbing-fixtures"
  ],
  "perplexity_source_urls_rejected": [
    "https://www.angi.com/articles/who-should-i-hire-bathtub-replacement-handyman-plumber.htm",
    "https://www.getjobber.com/academy/plumbing/plumbing-interview-questions/",
    "https://onpointplumber.com/plumbing-code-updates/",
    "https://polarplumbingandair.com/20-must-ask-questions-your-essential-plumber-interview-checklist/",
    "https://www.badeloftusa.com/how-to-guides/plumbers-install-or-replace-bathtubs/",
    "https://www.homecontractors.com/question-answer/can-you-install-a-bathtub-on-the-second-floor/",
    "https://stollwerckplumbing.com/7-red-flags-hiring-plumber/",
    "https://affordableplumbingco.com/warning-signs-to-look-out-for-when-hiring-a-plumber/"
  ],
  "tier1_scores": {
    "tdlr.texas.gov": 68,
    "sll.texas.gov": 65,
    "up.codes": 55,
    "codes.iccsafe.org": 63,
    "angi.com": 45,
    "getjobber.com": 43,
    "onpointplumber.com": 40,
    "polarplumbingandair.com": 37,
    "badeloftusa.com": 37,
    "homecontractors.com": 27,
    "stollwerckplumbing.com": 25,
    "affordableplumbingco.com": 25
  },
  "aji_dna_enabled": false,
  "local_source_path": "c:\\Users\\ceo\\Documents\\AI Training\\Anti Gravity\\Dynamic Research\\Documentation\\Plumbing Project Criteria and Candidate Selection - Google Gemini.pdf",
  "persona_configured": true,
  "topic_half_life": "3-5 years",
  "auth_verified_at": "2026-04-14T18:00:00Z",
  "queued_urls_for_notebooklm": [],
  "userContext": {
    "contextFilePath": null,
    "additionalUrls": [],
    "claimsToVerify": [],
    "domainKnowledge": [
      "Canyon Lake, TX (Comal County)",
      "Roughed-in second-floor bathroom",
      "Alcove tub with showerhead (mixing valve not on-site yet)",
      "Plywood subfloor section under tub position",
      "Multi-story pipe routing concerns",
      "Pressure testing and drain placement optimization"
    ],
    "constraints": [
      "Homeowner context, not executive/business",
      "No Aji DNA",
      "Gemini PDF as local source (quality bar)",
      "Vendor evaluation enabled"
    ],
    "localSourcePath": "c:\\Users\\ceo\\Documents\\AI Training\\Anti Gravity\\Dynamic Research\\Documentation\\Plumbing Project Criteria and Candidate Selection - Google Gemini.pdf"
  },
  "selectedProducts": {
    "audio": true,
    "video": true,
    "slides": true,
    "report": true,
    "infographic": true
  },
  "customizations": {
    "perplexity": {
      "queryFraming": "Homeowner evaluating plumbers in Canyon Lake, TX (Comal County)",
      "emphasis": ["Multi-story experience", "Code compliance", "Subfloor assessment", "Scoring methodology"],
      "outputStructure": "Weighted evaluation matrix"
    },
    "notebookLM": {
      "persona": "Senior home inspection consultant",
      "researchMode": "deep",
      "priorities": ["Code compliance", "Structural assessment", "Multi-story experience", "Gemini criteria"]
    },
    "studio": {
      "audio": { "tone": "conversational/educational", "format": "deep-dive", "hostStyle": "knowledgeable friend" },
      "video": { "style": "classic", "format": "explainer", "narratorTone": "practical/advisory" },
      "slides": { "layout": "minimal", "keyPointsPerSlide": 3 },
      "report": { "format": "briefing-doc", "depth": "comprehensive" },
      "infographic": { "orientation": "portrait", "keyStats": ["scoring weights", "red flags", "permit checklist"] }
    }
  },
  "vendorEvaluation": {
    "enabled": true,
    "vendorType": "plumber",
    "serviceArea": "Canyon Lake, TX / Comal County",
    "serviceAddress": "Canyon Lake, TX",
    "jobDescription": "Second-floor alcove bathtub installation",
    "maxVendorsDiscovered": 13,
    "maxVendorsEnriched": 4,
    "vendorsDiscovered": [
      "Anchor Plumbing Services", "Don's Plumbing", "Star State Plumbing", "NB Quality Plumbing",
      "Shamrock Plumbing", "Jon Wayne Plumbing", "Savior Service Co.", "Stable Services",
      "ME Plumbing", "Benjamin Franklin Plumbing", "Primo Plumbing", "Mr. Rooter", "ABC Home & Commercial"
    ],
    "vendorsShortlisted": [
      "Anchor Plumbing Services (M41829, 4.9/1500+)",
      "Don's Plumbing (M20158, LOCAL, 30+yrs)",
      "Star State Plumbing (BBB, 28+yrs)",
      "NB Quality Plumbing (remodel specialist)"
    ],
    "vendorsExcluded": [
      "Shamrock Plumbing", "Jon Wayne Plumbing", "Savior Service Co.", "Stable Services",
      "ME Plumbing", "Benjamin Franklin Plumbing", "Primo Plumbing", "Mr. Rooter", "ABC Home & Commercial"
    ],
    "preScreeningComplete": true
  },
  "artifacts": {
    "audio": { "task_id": "722699e2-9cd1-4d6c-abff-66a846c4fb4c", "status": "completed", "version": 3 },
    "report": { "task_id": "3e1e04ac-7add-47e3-b4d1-28952a7869ec", "status": "completed", "version": 3 },
    "slides": { "task_id": "ec0ee8da-4d33-4332-a200-2156610c4dca", "status": "completed", "version": 3 },
    "infographic": { "task_id": "c0a07d4c-2a6b-4b72-9674-6615d7c93324", "status": "completed", "version": 3 },
    "video": {
      "task_id": "2cdbc708-e816-49fc-a901-0c46e5a445fa", "status": "completed", "version": 3,
      "format": "cinematic",
      "alternate_tasks": ["eb192bab-30b7-4788-a982-98babe3b51b6", "46fe3f93-5efa-4a39-9933-4ef2b54bb492"]
    }
  },
  "files_written": [
    "20260414-062922-brief.md", "20260414-062922-perplexity.md", "20260414-062922-notebooklm.md",
    "20260414-062922-comparison.md", "20260414-062922-vendor-evaluation.md",
    "20260414-062922-audio-v3.mp3", "20260414-062922-report-v3.md",
    "20260414-062922-slides-v3.pptx", "20260414-062922-infographic-v3.png", "20260414-062922-video-v3.mp4"
  ],
  "version": 3,
  "projects_path": "Dynamic Research/Projects/canyon-lake-plumber-bathtub-install"
}
```

---

## Appendix C: confidence-index.md (CI Scoring Rubric)

> Defines the five-dimension scoring system. Tier 1 scores URLs (max 75), Tier 2 scores claims (max 100).

### Five-Dimension Scoring Table

| Dimension | Max Pts | What to Evaluate |
|-----------|---------|-----------------|
| **Source Credibility** | 30 | Publisher reputation: .gov/.edu/journal = 25-30; trade pub = 15-24; blog/social = 0-10 |
| **Author Credibility** | 25 | Verifiable expertise + affiliation = 20-25; partial = 10-19; none = 0-5 |
| **Currency** | 20 | Within 1 half-life = 16-20; within 2 = 8-15; older = 0-7 |
| **Corroboration** | 15 | 3+ independent sources = 13-15; 2 sources = 8-12; single = 0-7 |
| **Internal Consistency** | 10 | No contradiction = 8-10; minor tension = 4-7; direct contradiction = 0-3 |

**Total: 100 points**

### Topic Half-Life Guide

| Domain | Typical Half-Life |
|--------|-------------------|
| AI/ML tooling | ~3-6 months |
| Geopolitics, regulation | ~12 months |
| Medicine, clinical | ~2 years |
| Engineering best practices | ~3-5 years |
| History, math, physics | ~20+ years |

### Two-Tier Application

**Tier 1 — URL Filter:** Source Cred + Author Cred + Currency only (max 75). Threshold: >=60/75 (80%).

**Tier 2 — Claim Filter:** All 5 dimensions (max 100). Threshold: >=80/100.

**Hyperlocal adaptation:** For local topics (contractors, regional services), relax Tier 1 to >=50/75.

**Deduplication:** Merge identical claims across sources (P+N+C). Higher Corroboration for multi-source claims.

### Scope Note

> *The Confidence Index measures source quality and claim consensus, not verified factual truth.*

---

## Appendix D: vendor-scoring.md (Four-Phase Evaluation Framework)

> Layer 1 (pre-screening) feeds PreScreeningTable and ShortlistCards. Layer 2 (four-phase) feeds tabbed EvaluationFramework.

### Layer 1: Pre-Screening

**Discovery:** 3-5 WebSearch queries, up to 10 candidates. Collect: name, phone, website, rating, distance, specialties.

**Funnel filter:**

| Criterion | Pass/Fail |
|-----------|-----------|
| Active State License | Fail only if **confirmed** unlicensed. Unverifiable = flag |
| Insurance (COI) | Flag `[ ! ] VERIFY ON CALL` if unverifiable |
| Proximity | Exclude >50mi unless exceptional |
| Minimum Reputation | >=3.5 rating, >=5 reviews |
| Specialty Relevance | Flag if unclear |

**Data gap handling:** Neutral scores (5/10) for unverifiable info. `[ ! ] VERIFY ON CALL` flags. Only deal-break on confirmed bad practices.

### Layer 2: Four-Phase Framework

**Phase 1 — Prerequisites:** 3-5 pass/fail gates from highest-CI safety/compliance claims.
Format: `[ ] [Requirement]: [Standard]. Verification: [Method].`

**Phase 2 — Competency Matrix:** 4-6 weighted competencies (sum to 100%). Scoring: 5=Exceptional, 4=Strong, 3=Adequate, 2=Weak, 1=DQ.

**Phase 3 — Interview Protocol:** 4-6 on-site prompts with target answer (Score 5) and red flag (Score 1).

**Phase 4 — Contract Checklist:** SOW line items from Phase 3 answers. Standard items always included: materials, payment, permits, testing, warranty.

### Weight Profiles

| Job Type | License | Specialty | Proximity | Reputation | Responsive | Pricing | Warranty |
|----------|---------|-----------|-----------|------------|------------|---------|----------|
| Emergency | 15 | 10 | 20 | 15 | 25 | 5 | 10 |
| New Construction | 20 | 25 | 10 | 15 | 5 | 15 | 10 |
| Remodel | 20 | 20 | 10 | 20 | 10 | 10 | 10 |
| Routine | 15 | 10 | 15 | 20 | 15 | 15 | 10 |

---

## Appendix E: executive-voice.md (Aji DNA — Communication Framework)

> Conditional feature (enabled via `aji_dna_enabled`). When active, display "Aji DNA" badge.

### Vocabulary Rules

| Always Use | Instead of |
|------------|-----------|
| Superior | excellent, great, best |
| Uncommon | unique, different |
| Ambitions | goals |
| Produce | achieve, create |
| Fulfill | meet |
| Distinction | difference |

### Never Use
- "Common sense," "hard work" as virtue, "tips and techniques," "best practices"
- Hedging: might, could, try, hopefully, perhaps, maybe

### Application to /research-compare
- Preamble: frame for "ambitious professionals"
- Synthesis: prescriptive ("You must..."), not descriptive
- Recommendations: connect to economic outcomes
- Studio outputs: embody strategic authority

---

*End of spec. This document is self-contained — Gemini has everything needed to build the frontend.*
