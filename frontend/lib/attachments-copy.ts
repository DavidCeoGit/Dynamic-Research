/**
 * Pure, unit-testable helpers for the submit-time attachment verify+copy flow
 * (Phase 2 file-upload). No I/O lives here — the impure storage orchestration
 * (list/copy/audit against Supabase) is in ./storage.ts
 * (verifyAndCopyAttachments), which builds on the pure planners below.
 *
 * Why a separate module: frontend route handlers have no test harness, but the
 * security-load-bearing decisions — which bytes get copied FROM where, and the
 * Clone/Replay parent-carry mapping (plan §3b, the CRITICAL Gemini-grounded
 * finding from the S102 Phase-1 review) — must be covered by automated tests.
 * Keeping them pure makes that possible.
 */

import {
  scopedStagingPath,
  scopedSourcesPath,
} from "./storage-paths";
import type {
  AttachmentMeta,
  AttachmentPayloadItem,
  AttachmentOrigin,
} from "./types/queue";

/**
 * Map a parent run's stored attachments (plain AttachmentMeta, origin already
 * stripped at the parent's own submit) into payload items tagged
 * origin:"parent" so Clone & Edit and Replay carry them forward. The submit /
 * replay route then verifies each still exists under the parent's sources/ and
 * copies it into the new run's sources/.
 *
 * This is the §3b fix: without it, replaying or cloning an attachment-bearing
 * run silently drops the files. Unit-tested in attachments.test.ts.
 */
export function mapDbAttachmentsToParentPayload(
  dbAttachments: readonly AttachmentMeta[] | null | undefined,
): AttachmentPayloadItem[] {
  if (!dbAttachments || dbAttachments.length === 0) return [];
  return dbAttachments.map((a) => ({
    originalName: a.originalName,
    storedName: a.storedName,
    sizeBytes: a.sizeBytes,
    contentType: a.contentType,
    uploadedAt: a.uploadedAt,
    origin: "parent" as const,
  }));
}

/** Split payload attachments by where their bytes currently live. */
export function partitionByOrigin(items: readonly AttachmentPayloadItem[]): {
  staging: AttachmentPayloadItem[];
  parent: AttachmentPayloadItem[];
} {
  const staging: AttachmentPayloadItem[] = [];
  const parent: AttachmentPayloadItem[] = [];
  for (const it of items) {
    if (it.origin === "staging") staging.push(it);
    else parent.push(it);
  }
  return { staging, parent };
}

/**
 * Drop the payload-only `origin` field, yielding the plain AttachmentMeta the
 * DB column stores. The submit route persists this AFTER the copy resolves.
 */
export function stripOrigin(
  items: readonly AttachmentPayloadItem[],
): AttachmentMeta[] {
  return items.map(({ origin: _origin, ...meta }) => meta);
}

/** One resolved copy: object bytes move from `fromPath` → `toPath`. */
export interface CopyPlanEntry {
  storedName: string;
  origin: AttachmentOrigin;
  /** Source object key (staging dir or parent sources dir). */
  fromPath: string;
  /** Destination object key in the new run's sources/ folder. */
  toPath: string;
  /** Claimed size; re-verified against the live object before any copy. */
  sizeBytes: number;
}

export interface BuildCopyPlanOpts {
  orgId: string;
  /** Slug of the run being created (copy destination). */
  newSlug: string;
  /** Required when any staging item is present. */
  draftId?: string | null;
  /** Required when any parent item is present. */
  parentSlug?: string | null;
  items: readonly AttachmentPayloadItem[];
}

/**
 * Resolve each payload attachment to a concrete {fromPath, toPath} pair, with
 * defense-in-depth contract checks beyond the zod superRefine: a staging item
 * with no draftId, or a parent item with no parentSlug, throws here rather than
 * silently constructing a wrong path. All paths go through scopedStagingPath /
 * scopedSourcesPath, which re-validate orgId/draftId UUID shape, the storedName
 * regex, `..`, and Windows reserved basenames at every construction.
 *
 * Pure: throws on contract violation, never does I/O. Storage existence/size
 * verification happens in the impure orchestrator that consumes this plan.
 */
export function buildCopyPlan(opts: BuildCopyPlanOpts): CopyPlanEntry[] {
  const { orgId, newSlug, draftId, parentSlug, items } = opts;
  // Codex MERGE-gate BLOCKING — two payload items sharing a storedName resolve
  // to the SAME destination toPath (<orgId>/<newSlug>/sources/<storedName>). The
  // second copy() would then clobber or collide with the first, and the row's
  // stored AttachmentMeta[] would claim N files while sources/ holds fewer — a
  // SILENT data-integrity loss (esp. a clone whose parent carry-over collides
  // with a freshly-uploaded same-named file, because the mint route's collision
  // suffix only de-duped against staged files, not parent carry-overs). Reject
  // here, server-side, so the bug fails LOUD (400) independent of any
  // client-side suffixing. storedName is the unique key within a run's sources/.
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.storedName)) {
      throw new Error(
        `buildCopyPlan: duplicate storedName "${it.storedName}" — two attachments would copy to the same destination`,
      );
    }
    seen.add(it.storedName);
  }
  return items.map((it) => {
    let fromPath: string;
    if (it.origin === "staging") {
      if (!draftId) {
        throw new Error(
          `buildCopyPlan: staging attachment "${it.storedName}" requires attachmentsDraftId`,
        );
      }
      fromPath = scopedStagingPath(orgId, draftId, it.storedName);
    } else {
      if (!parentSlug) {
        throw new Error(
          `buildCopyPlan: parent attachment "${it.storedName}" requires parentSlug`,
        );
      }
      fromPath = scopedSourcesPath(orgId, parentSlug, it.storedName);
    }
    return {
      storedName: it.storedName,
      origin: it.origin,
      fromPath,
      toPath: scopedSourcesPath(orgId, newSlug, it.storedName),
      sizeBytes: it.sizeBytes,
    };
  });
}
