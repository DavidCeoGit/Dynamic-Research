"use client";

import {
  Settings,
  Cpu,
  PackageCheck,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Global status ───────────────────────────────────────────────────

/**
 * High-level lifecycle stage derived from the CLI's `phase` + `phase_status`.
 *
 * Maps the 12+ granular CLI phases into 5 viewer-friendly steps:
 *   initializing  →  phase 0.5, 0   (discussion + preflight)
 *   processing    →  phase 1–4      (research + scoring + import + extraction)
 *   finalizing    →  phase 5–5.5    (synthesis + vendors + studio)
 *   complete      →  phase 6        (done)
 *   error         →  any phase with aborted / error status
 */
export type GlobalStatus =
  | "initializing"
  | "processing"
  | "finalizing"
  | "complete"
  | "error";

export function deriveGlobalStatus(
  phase: string,
  phaseStatus: string,
): GlobalStatus {
  if (phaseStatus === "aborted_by_user") return "error";

  const p = parseFloat(phase);
  if (Number.isNaN(p)) return "initializing";
  if (p <= 0) return "initializing";
  if (p < 5) return "processing";
  if (p < 6) return "finalizing";
  if (p >= 6 && phaseStatus === "complete") return "complete";
  return "finalizing"; // phase 6 but not yet "complete"
}

// ── Step definitions ────────────────────────────────────────────────

interface StepDef {
  id: GlobalStatus;
  label: string;
  icon: LucideIcon;
}

const STEPS: StepDef[] = [
  { id: "initializing", label: "Initializing", icon: Settings },
  { id: "processing",   label: "Processing",   icon: Cpu },
  { id: "finalizing",   label: "Finalizing",    icon: PackageCheck },
  { id: "complete",     label: "Complete",       icon: CheckCircle2 },
  { id: "error",        label: "Error",          icon: AlertTriangle },
];

// Index lookup: which ordinal position does each status occupy?
const STATUS_ORDER: Record<GlobalStatus, number> = {
  initializing: 0,
  processing: 1,
  finalizing: 2,
  complete: 3,
  error: 4, // rendered separately — always last
};

// ── Colour helpers ──────────────────────────────────────────────────

/** Dot / icon colour for the given step relative to the active status. */
function dotClass(
  stepStatus: GlobalStatus,
  activeStatus: GlobalStatus,
  stepIdx: number,
  activeIdx: number,
): string {
  // Error always red
  if (activeStatus === "error" && stepStatus === "error")
    return "border-red-500 bg-red-500/20 text-red-400";

  // Hide the error dot unless the run is actually in error
  if (stepStatus === "error" && activeStatus !== "error")
    return "border-zinc-700 bg-zinc-800 text-zinc-600 opacity-40";

  // Completed steps
  if (stepIdx < activeIdx)
    return "border-[#3b82f6] bg-[#3b82f6]/20 text-[#3b82f6]";

  // Active step
  if (stepIdx === activeIdx)
    return "border-[#c8a951] bg-[#c8a951]/20 text-[#c8a951]";

  // Complete gets azure instead of gold
  if (stepStatus === "complete" && activeStatus === "complete")
    return "border-[#3b82f6] bg-[#3b82f6]/20 text-[#3b82f6]";

  // Future steps
  return "border-zinc-700 bg-zinc-800 text-zinc-600";
}

/** Connector line colour between step[i] and step[i+1]. */
function lineClass(
  stepIdx: number,
  activeIdx: number,
  activeStatus: GlobalStatus,
): string {
  if (activeStatus === "error") return "bg-zinc-700";
  if (stepIdx < activeIdx) return "bg-[#3b82f6]";
  return "bg-zinc-700";
}

/** Label colour beneath the dot. */
function labelClass(
  stepIdx: number,
  activeIdx: number,
  activeStatus: GlobalStatus,
  stepStatus: GlobalStatus,
): string {
  if (stepStatus === "error" && activeStatus !== "error")
    return "text-zinc-600 opacity-40";
  if (activeStatus === "error" && stepStatus === "error")
    return "text-red-400";
  if (stepIdx < activeIdx) return "text-[#3b82f6]";
  if (stepIdx === activeIdx) return "text-[#c8a951]";
  if (stepStatus === "complete" && activeStatus === "complete")
    return "text-[#3b82f6]";
  return "text-zinc-500";
}

// ── Component ───────────────────────────────────────────────────────

interface PhaseTimelineProps {
  phase: string;
  phaseStatus: string;
}

export default function PhaseTimeline({
  phase,
  phaseStatus,
}: PhaseTimelineProps) {
  const activeStatus = deriveGlobalStatus(phase, phaseStatus);
  const activeIdx = STATUS_ORDER[activeStatus];

  // When not in error, render the first 4 steps (skip error dot).
  // When in error, render all 5.
  const visibleSteps =
    activeStatus === "error" ? STEPS : STEPS.filter((s) => s.id !== "error");

  return (
    <div className="flex items-center justify-center gap-0">
      {visibleSteps.map((step, i) => {
        const stepIdx = STATUS_ORDER[step.id];
        const isActive =
          stepIdx === activeIdx &&
          activeStatus !== "complete" &&
          activeStatus !== "error";

        const Icon = step.icon;

        return (
          <div key={step.id} className="flex items-center">
            {/* ── Step dot ───────────────────────────────── */}
            <div className="flex flex-col items-center">
              <div
                className={[
                  "flex h-10 w-10 items-center justify-center rounded-full border-2 transition-colors",
                  dotClass(step.id, activeStatus, stepIdx, activeIdx),
                  isActive ? "animate-pulse-slow" : "",
                ].join(" ")}
              >
                <Icon className="h-5 w-5" />
              </div>
              <span
                className={[
                  "mt-2 text-[11px] font-medium tracking-wide",
                  labelClass(stepIdx, activeIdx, activeStatus, step.id),
                ].join(" ")}
              >
                {step.label}
              </span>
            </div>

            {/* ── Connector line (skip after last visible step) ── */}
            {i < visibleSteps.length - 1 && (
              <div
                className={[
                  "mx-2 mt-[-1.25rem] h-0.5 w-12 sm:w-20 rounded-full transition-colors",
                  lineClass(stepIdx, activeIdx, activeStatus),
                ].join(" ")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
