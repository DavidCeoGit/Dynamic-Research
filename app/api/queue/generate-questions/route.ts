/**
 * POST /api/queue/generate-questions
 *
 * Uses the Vercel AI SDK with Claude Sonnet to generate 5-7 refinement
 * questions based on a research topic. Returns structured JSON via
 * generateObject with a strict Zod schema.
 */

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateQuestionsSchema, questionsResponseSchema } from "@/lib/validate";

export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You are a senior research analyst helping a user scope a deep research project.

Given a research topic (1-3 sentences), generate exactly 5-7 targeted refinement questions that will help narrow the scope and produce better research output.

Rules for question generation:
- Questions should progressively narrow the scope (broad context → specific constraints)
- Include at least one question about geographic/jurisdictional relevance if applicable
- Include one question probing whether this is a vendor/service evaluation or pure topic research
- Each question must specify a mappedField indicating where the answer belongs:
  - "domainKnowledge" — factual context the user provides
  - "constraints" — boundaries, exclusions, preferences
  - "additionalUrls" — reference URLs the user wants included
  - "claimsToVerify" — specific claims to fact-check
  - "vendorEvaluation" — if this is about evaluating service providers
  - "ajiDnaEnabled" — if user wants executive communication styling
- Use "text" type for open-ended questions
- Use "boolean" type for yes/no toggles (vendorEvaluation, ajiDnaEnabled)
- Use "multiselect" type when offering predefined choices (provide options array)
- Make questions conversational and specific to the topic, not generic`;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = generateQuestionsSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: questionsResponseSchema,
      system: SYSTEM_PROMPT,
      prompt: `Research topic: "${parsed.data.topic}"

Generate 5-7 refinement questions to help scope this research effectively.`,
    });

    return Response.json(result.object);
  } catch (err) {
    return Response.json(
      { error: "Question generation failed", detail: String(err) },
      { status: 500 },
    );
  }
}
