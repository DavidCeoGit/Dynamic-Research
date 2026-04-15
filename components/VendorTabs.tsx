"use client";

import { useState } from "react";
import type { RunState } from "@/hooks/useRunState";
import {
  Sparkles,
  Globe,
  BookOpen,
  Brain,
  CheckCircle2,
  Clock,
  XCircle,
  AlertCircle,
} from "lucide-react";

// ── Tab definitions ─────────────────────────────────────────────────

type TabId = "synthesis" | "perplexity" | "notebooklm" | "claude";

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof Globe;
}

const TABS: TabDef[] = [
  { id: "synthesis",   label: "Final Synthesis", icon: Sparkles },
  { id: "perplexity",  label: "Perplexity",      icon: Globe },
  { id: "notebooklm",  label: "NotebookLM",      icon: BookOpen },
  { id: "claude",      label: "Claude",           icon: Brain },
];

// ── Helpers ─────────────────────────────────────────────────────────

function hasFile(files: string[], pattern: string): boolean {
  return files.some((f) => f.includes(pattern));
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        ok
          ? "bg-emerald-500/10 text-emerald-400"
          : "bg-zinc-800 text-zinc-500"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      {label}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  if (value === null || value === undefined) return null;
  const display = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  return (
    <div className="flex justify-between border-b border-zinc-800 py-2 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-zinc-300">{display}</span>
    </div>
  );
}

function TagList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Tab panels ──────────────────────────────────────────────────────

function SynthesisPanel({ state }: { state: RunState }) {
  const hasComparison = hasFile(state.files_written, "comparison");
  const hasVendorEval = hasFile(state.files_written, "vendor-evaluation");
  const productCount = Object.values(state.selectedProducts).filter(Boolean).length;
  const completedArtifacts = Object.values(state.artifacts).filter(
    (a) => a.status === "completed",
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <StatusBadge ok={hasComparison} label="Comparison" />
        <StatusBadge ok={hasVendorEval} label="Vendor Eval" />
        <StatusBadge
          ok={state.phase_status === "complete"}
          label={state.phase_status === "complete" ? "Complete" : "In Progress"}
        />
      </div>

      <DetailRow label="Version" value={`v${state.version}`} />
      <DetailRow label="Phase" value={`${state.phase} — ${state.phase_status.replace(/_/g, " ")}`} />
      <DetailRow label="Products Selected" value={productCount} />
      <DetailRow label="Artifacts Completed" value={`${completedArtifacts}/${productCount}`} />
      <DetailRow label="Files Written" value={state.files_written.length} />
      <DetailRow label="Half-life" value={state.topic_half_life} />
      <DetailRow label="Aji DNA" value={state.aji_dna_enabled} />

      {state.files_written.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-zinc-500">Output Files</p>
          <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-400">
            {state.files_written.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PerplexityPanel({ state }: { state: RunState }) {
  const hasOutput = hasFile(state.files_written, "perplexity");
  const passedCount = state.perplexity_source_urls_passed.length;
  const rejectedCount = state.perplexity_source_urls_rejected.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <StatusBadge ok={hasOutput} label={hasOutput ? "Output Ready" : "Pending"} />
        <StatusBadge ok={state.perplexity_mcp_available} label={state.perplexity_mcp_available ? "MCP Active" : "WebSearch Fallback"} />
      </div>

      <DetailRow label="Query Framing" value={state.customizations.perplexity.queryFraming} />
      <DetailRow label="Output Structure" value={state.customizations.perplexity.outputStructure} />
      <DetailRow label="URLs Passed Tier 1" value={passedCount} />
      <DetailRow label="URLs Rejected Tier 1" value={rejectedCount} />

      <TagList label="Emphasis Areas" items={state.customizations.perplexity.emphasis} />

      {passedCount > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-emerald-400">Passed URLs</p>
          <div className="mt-1.5 max-h-32 overflow-y-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-400">
            {state.perplexity_source_urls_passed.map((u) => (
              <div key={u} className="truncate">{u}</div>
            ))}
          </div>
        </div>
      )}

      {rejectedCount > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-red-400">Rejected URLs</p>
          <div className="mt-1.5 max-h-32 overflow-y-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-400">
            {state.perplexity_source_urls_rejected.map((u) => (
              <div key={u} className="truncate">{u}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NotebookLMPanel({ state }: { state: RunState }) {
  const hasOutput = hasFile(state.files_written, "notebooklm");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <StatusBadge ok={hasOutput} label={hasOutput ? "Output Ready" : "Pending"} />
        <StatusBadge ok={state.persona_configured} label={state.persona_configured ? "Persona Set" : "No Persona"} />
      </div>

      <DetailRow label="Notebook ID" value={state.notebook_id} />
      <DetailRow label="Notebook Title" value={state.notebook_title} />
      <DetailRow label="Persona" value={state.customizations.notebookLM.persona} />
      <DetailRow label="Research Mode" value={state.customizations.notebookLM.researchMode} />

      <TagList label="Priorities" items={state.customizations.notebookLM.priorities} />
    </div>
  );
}

function ClaudePanel({ state }: { state: RunState }) {
  const hasBrief = hasFile(state.files_written, "brief");
  const knowledge = state.userContext.domainKnowledge;
  const claims = state.userContext.claimsToVerify;
  const constraints = state.userContext.constraints;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <StatusBadge ok={hasBrief} label={hasBrief ? "Brief Ready" : "Pending"} />
      </div>

      <p className="text-xs text-zinc-500">
        Claude provides the baseline knowledge snapshot — claims assessed
        before platform results arrive.
      </p>

      <TagList label="Domain Knowledge" items={knowledge} />
      <TagList label="Claims to Verify" items={claims} />
      <TagList label="Constraints" items={constraints} />
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────

interface VendorTabsProps {
  state: RunState;
}

export default function VendorTabs({ state }: VendorTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>("synthesis");

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      {/* ── Tab bar ──────────────────────────────────────────── */}
      <div className="flex border-b border-zinc-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={[
              "flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors",
              activeTab === id
                ? "border-b-2 border-[#c8a951] text-[#c8a951]"
                : "text-zinc-500 hover:text-zinc-300",
            ].join(" ")}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* ── Tab panel ────────────────────────────────────────── */}
      <div className="p-6">
        {activeTab === "synthesis" && <SynthesisPanel state={state} />}
        {activeTab === "perplexity" && <PerplexityPanel state={state} />}
        {activeTab === "notebooklm" && <NotebookLMPanel state={state} />}
        {activeTab === "claude" && <ClaudePanel state={state} />}
      </div>
    </div>
  );
}
