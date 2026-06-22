/**
 * S153 — context-extraction UX unit tests.
 *
 * Covers the three-defect "complete fix" and the specific counterexamples the
 * MERGE-gate reviewers raised:
 *   - url-normalize: AES misextraction (v1.1, trailing-dot domain) dropped;
 *     schemed localhost/IP preserved (Codex MAJOR-4); 2000-char cap.
 *   - replaceExtracted: unconditional clear of prior extracted on null/[] (Codex
 *     MAJOR-2); user/user_edited items survive (Gemini CRITICAL data-loss).
 *   - addUserValue: promote-on-match instead of dup-skip (Codex MAJOR-3).
 *   - toFormUserContext / serializeUserContext: legacy string[] <-> ContextItem[]
 *     boundary, publishRequired preserved (Codex CRITICAL sessionStorage path).
 *
 * Run: node --import=tsx --test frontend/lib/__tests__/context-extraction.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrlCandidate, isValidUrlItem } from "../url-normalize";
import {
  toFormUserContext,
  serializeUserContext,
  replaceExtracted,
  addUserValue,
  makeContextItem,
  type ContextItem,
} from "../context-items";

// ── url-normalize ───────────────────────────────────────────────────

test("normalizeUrlCandidate: drops the AES misextractions", () => {
  assert.equal(normalizeUrlCandidate("v1.1"), null);
  assert.equal(normalizeUrlCandidate("https://v1.1"), null);
  assert.equal(normalizeUrlCandidate("negotiating"), null);
  assert.equal(normalizeUrlCandidate(""), null);
  assert.equal(normalizeUrlCandidate(undefined), null);
});

test("normalizeUrlCandidate: canonicalizes a sentence-final bare domain", () => {
  assert.equal(
    normalizeUrlCandidate("leginfo.legislature.ca.gov."),
    "https://leginfo.legislature.ca.gov",
  );
  assert.equal(normalizeUrlCandidate("example.com"), "https://example.com");
  assert.equal(normalizeUrlCandidate("example.com/path"), "https://example.com/path");
});

test("normalizeUrlCandidate: preserves schemed localhost / IP (Codex MAJOR-4)", () => {
  assert.equal(normalizeUrlCandidate("http://localhost:3000/foo"), "http://localhost:3000/foo");
  assert.equal(normalizeUrlCandidate("https://127.0.0.1/a"), "https://127.0.0.1/a");
  // A valid schemed URL with a legitimate trailing paren must NOT be stripped.
  assert.equal(
    normalizeUrlCandidate("https://en.wikipedia.org/wiki/Foo_(bar)"),
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  );
});

test("normalizeUrlCandidate: enforces the 2000-char cap", () => {
  const long = "https://example.com/" + "a".repeat(2100);
  assert.equal(normalizeUrlCandidate(long), null);
});

test("isValidUrlItem: ok+normalized on valid, message on invalid", () => {
  const good = isValidUrlItem("example.com");
  assert.equal(good.ok, true);
  assert.equal(good.normalized, "https://example.com");
  const bad = isValidUrlItem("v1.1");
  assert.equal(bad.ok, false);
  assert.ok(bad.message && bad.message.length > 0);
  assert.equal(isValidUrlItem("").message, "Empty — remove or enter a URL");
});

// ── replaceExtracted (Defect 2) ─────────────────────────────────────

test("replaceExtracted: clears prior extracted even when new set is null/[] (Codex MAJOR-2)", () => {
  const current: ContextItem[] = [makeContextItem("https://old.example", "extracted")];
  assert.deepEqual(replaceExtracted(current, null), []);
  assert.deepEqual(replaceExtracted(current, []), []);
});

test("replaceExtracted: preserves user + user_edited_extracted, swaps extracted", () => {
  const u = makeContextItem("https://typed.example", "user");
  const e = makeContextItem("https://old.example", "extracted");
  const ed: ContextItem = { ...makeContextItem("https://edited.example", "user_edited_extracted") };
  const next = replaceExtracted([u, e, ed], ["https://new.example"]);
  const values = next.map((i) => i.value).sort();
  assert.deepEqual(values, ["https://edited.example", "https://new.example", "https://typed.example"]);
  assert.equal(next.find((i) => i.value === "https://old.example"), undefined);
  assert.equal(next.find((i) => i.value === "https://new.example")?.source, "extracted");
});

// ── addUserValue (Codex MAJOR-3) ────────────────────────────────────

test("addUserValue: appends a new user value", () => {
  const next = addUserValue([], "Texas");
  assert.equal(next.length, 1);
  assert.equal(next[0].source, "user");
  assert.equal(next[0].value, "Texas");
});

test("addUserValue: promotes a matching extracted item instead of dup-skip", () => {
  const current: ContextItem[] = [makeContextItem("Texas", "extracted")];
  const next = addUserValue(current, "Texas");
  assert.equal(next.length, 1);
  assert.equal(next[0].source, "user_edited_extracted");
});

test("addUserValue: no duplicate when value already user-owned", () => {
  const current: ContextItem[] = [makeContextItem("Texas", "user")];
  const next = addUserValue(current, "Texas");
  assert.equal(next.length, 1);
  assert.equal(next[0].source, "user");
});

// ── Gemini CRITICAL data-loss counterexample (end-to-end) ───────────

test("Gemini counterexample: a re-affirmed extracted value survives re-extraction", () => {
  // 1. "Texas" extracted from topic.
  let constraints: ContextItem[] = replaceExtracted([], ["Texas"]);
  assert.equal(constraints[0].source, "extracted");
  // 2. User re-affirms "Texas" via a dynamic question → promote (not dup-skip).
  constraints = addUserValue(constraints, "Texas");
  assert.equal(constraints[0].source, "user_edited_extracted");
  // 3. Topic changed to Florida → re-extraction returns ["Florida"].
  constraints = replaceExtracted(constraints, ["Florida"]);
  const values = constraints.map((i) => i.value).sort();
  // The user-confirmed "Texas" MUST NOT be destroyed (the old string-set bug).
  assert.deepEqual(values, ["Florida", "Texas"]);
});

// ── boundary adapters (Codex CRITICAL sessionStorage path) ──────────

test("toFormUserContext: legacy string[] -> ContextItem[] source:user, preserves publishRequired", () => {
  const legacy = {
    domainKnowledge: ["fact a"],
    additionalUrls: ["https://leginfo.legislature.ca.gov"],
    constraints: [],
    claimsToVerify: [],
    publishRequired: true,
  };
  const fc = toFormUserContext(legacy);
  assert.equal(fc.domainKnowledge[0].value, "fact a");
  assert.equal(fc.domainKnowledge[0].source, "user");
  assert.equal(typeof fc.domainKnowledge[0].id, "string");
  assert.equal(fc.additionalUrls[0].value, "https://leginfo.legislature.ca.gov");
  assert.equal(fc.publishRequired, true);
});

test("toFormUserContext: new ContextItem[] passes through; missing/garbage -> []", () => {
  const item = makeContextItem("x", "extracted");
  const fc = toFormUserContext({ domainKnowledge: [item], publishRequired: false });
  assert.equal(fc.domainKnowledge[0].source, "extracted");
  assert.equal(fc.domainKnowledge[0].id, item.id);
  const empty = toFormUserContext(undefined);
  assert.deepEqual(empty.additionalUrls, []);
  assert.equal(empty.publishRequired, false);
});

test("serializeUserContext: ContextItem[] -> string[], round-trips through toFormUserContext", () => {
  const fc = toFormUserContext({
    additionalUrls: ["https://a.example", "https://b.example"],
    domainKnowledge: ["k1"],
    constraints: [],
    claimsToVerify: [],
    publishRequired: true,
  });
  const wire = serializeUserContext(fc);
  assert.deepEqual(wire.additionalUrls, ["https://a.example", "https://b.example"]);
  assert.deepEqual(wire.domainKnowledge, ["k1"]);
  assert.equal(wire.publishRequired, true);
  // No provenance leaks to the wire.
  assert.equal(typeof wire.additionalUrls[0], "string");
});
