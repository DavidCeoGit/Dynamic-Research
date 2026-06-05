"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { ShieldAlert } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────

interface CIScoreChartProps {
  /** domain → Tier 1 score (max 75) */
  tier1Scores: Record<string, number> | undefined;
  /** Domains that passed Tier 1 */
  passedUrls: string[];
  /** Domains that failed Tier 1 */
  rejectedUrls: string[];
  /** Topic half-life (displayed in header) */
  topicHalfLife: string | null;
}

interface BarDatum {
  domain: string;
  score: number;
  passed: boolean;
}

// ── Constants ───────────────────────────────────────────────────────

const THRESHOLD = 60;
const MAX_SCORE = 75;
const COLOR_PASS = "#3b82f6";   // azure
const COLOR_FAIL = "#ef4444";   // red
const COLOR_GRID = "#27272a";   // zinc-800
const COLOR_THRESHOLD = "#c8a951"; // gold

// ── Component ───────────────────────────────────────────────────────

export default function CIScoreChart({
  tier1Scores,
  passedUrls,
  rejectedUrls,
  topicHalfLife,
}: CIScoreChartProps) {
  // ── Unavailable state ──────────────────────────────────────────
  if (!tier1Scores || Object.keys(tier1Scores).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 py-12 text-zinc-500">
        <ShieldAlert className="h-8 w-8 text-zinc-600" />
        <p className="mt-3 text-sm font-medium">CI Data Unavailable</p>
        <p className="mt-1 text-xs text-zinc-600">
          Tier 1 scoring has not been run yet for this session.
        </p>
      </div>
    );
  }

  // ── Build data ─────────────────────────────────────────────────
  const passedSet = new Set(
    passedUrls.map((u) => {
      try { return new URL(u).hostname; } catch { return u; }
    }),
  );

  const data: BarDatum[] = Object.entries(tier1Scores)
    .map(([domain, score]) => ({
      domain,
      score,
      passed: passedSet.has(domain),
    }))
    .sort((a, b) => b.score - a.score);

  const passCount = data.filter((d) => d.passed).length;
  const failCount = data.length - passCount;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">
            Tier 1 — URL Confidence Scores
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Threshold: {THRESHOLD}/{MAX_SCORE}
            {topicHalfLife && ` · Half-life: ${topicHalfLife}`}
          </p>
        </div>
        <div className="flex gap-4 text-xs">
          <span className="text-[#3b82f6]">
            {passCount} passed
          </span>
          <span className="text-red-400">
            {failCount} rejected
          </span>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 32)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={COLOR_GRID}
            horizontal={false}
          />
          <XAxis
            type="number"
            domain={[0, MAX_SCORE]}
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={{ stroke: COLOR_GRID }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="domain"
            width={140}
            tick={{ fill: "#a1a1aa", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#18181b",
              border: "1px solid #27272a",
              borderRadius: 6,
              fontSize: 12,
              color: "#e4e4e7",
            }}
            formatter={(value) => [`${value}/${MAX_SCORE}`, "Score"]}
            cursor={{ fill: "rgba(255,255,255,0.03)" }}
          />
          <ReferenceLine
            x={THRESHOLD}
            stroke={COLOR_THRESHOLD}
            strokeDasharray="6 3"
            strokeWidth={1.5}
            label={{
              value: `Threshold (${THRESHOLD})`,
              position: "top",
              fill: COLOR_THRESHOLD,
              fontSize: 10,
            }}
          />
          <Bar dataKey="score" radius={[0, 4, 4, 0]} barSize={16}>
            {data.map((entry) => (
              <Cell
                key={entry.domain}
                fill={entry.passed ? COLOR_PASS : COLOR_FAIL}
                fillOpacity={0.8}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
