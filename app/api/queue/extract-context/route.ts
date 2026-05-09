/**
 * POST /api/queue/extract-context
 *
 * Path B (S29): structured extraction of context dimensions already covered
 * by the research topic. Returns a typed object whose fields are either
 * populated (topic addresses the dimension) or null (topic is silent).
 *
 * Used as input to /api/queue/generate-questions to mechanically skip
 * questions for already-covered ground.
 */

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { extractContextRequestSchema, extractedContextSchema } from "@/lib/validate";

export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You are extracting structured context from a research topic so the downstream form can avoid asking the user redundant clarifying questions.

For each dimension below, return EITHER the values the topic already states OR null if the topic does NOT address the dimension at all. Do NOT infer or hallucinate — only extract what the topic literally states or strongly implies.

Dimensions:
  - domainKnowledge: facts, prior research, or explicit background context about the subject. Each fact = one array item. null if topic is purely a request without supporting context.
  - constraints: geographic, temporal, budget, regulatory, scope-exclusion, or any other limits the user states. Each constraint = one array item.
  - additionalUrls: any URLs cited within the topic text. ALWAYS include the https:// scheme — if the topic mentions "cloud.google.com/x", emit "https://cloud.google.com/x". Bare-domain output causes broken relative-URL navigation in the form. null if no URLs.
  - claimsToVerify: specific factual or numerical claims worth fact-checking against external sources. Each claim = one array item. null if topic contains no concrete claims.
  - vendorEvaluation: { enabled, vendorType, serviceArea }
      enabled = true ONLY if the topic explicitly frames this as a vendor / service-provider comparison. null if the topic gives no clear vendor signal.
      vendorType = the type of vendor/service if stated (e.g. "HVAC contractor", "law firm"). null otherwise.
      serviceArea = geographic service area if stated. null otherwise.
      Return null for the entire vendorEvaluation object if the topic gives NO vendor signal.
  - ajiDnaEnabled: true ONLY if the topic explicitly requests executive-summary tone, C-suite framing, or names the AJI DNA voice. null otherwise.

Rules:
  - Return null (not an empty array, not an empty string) if a dimension is genuinely not addressed.
  - Be terse: each array item should be a phrase or short sentence, not a paragraph.
  - For nested objects (vendorEvaluation), set individual fields to null when their value is unstated, even if other fields in the same object have values.
  - Bias toward null. If unsure whether something is "stated," it's not — return null.`;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = extractContextRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: extractedContextSchema,
      system: SYSTEM_PROMPT,
      prompt: `Topic (${parsed.data.topic.length} chars):
"""
${parsed.data.topic}
"""

Extract the structured context. Return null for any dimension the topic does not address.`,
    });

    return Response.json({ extractedContext: result.object });
  } catch (err) {
    return Response.json(
      { error: "Context extraction failed", detail: String(err) },
      { status: 500 },
    );
  }
}
