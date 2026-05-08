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

Topic length determines question density:
- BRIEF (under 500 chars / 1-3 sentences): Generate 5-7 questions covering all scoping dimensions.
- DETAILED (500-2000 chars): Generate 3-5 questions, focusing on what is NOT already covered.
- COMPREHENSIVE (over 2000 chars / full briefs): Generate 2-4 questions targeted at genuine ambiguities only. Skip anything the topic already answers.

Path A (S28): Before drafting questions, scan the topic for already-stated context across these dimensions:
  - domainKnowledge - facts, prior research, context the user mentions
  - constraints - geographic, temporal, budget, scope exclusions
  - additionalUrls - URLs already cited in the topic
  - claimsToVerify - specific claims worth fact-checking
  - vendorEvaluation - explicit vendor/service comparison framing
  - ajiDnaEnabled - executive/exec-summary tone signaling
If a dimension is already well-covered in the topic, DO NOT generate a question for it. Confirmation questions for clearly-stated info waste the user time.

Question generation rules:
- Questions progressively narrow the scope (broad context to specific constraints)
- Each question MUST specify a mappedField indicating where the answer belongs:
  - "domainKnowledge", "constraints", "additionalUrls", "claimsToVerify", "vendorEvaluation", "ajiDnaEnabled"
- Use "text" type for open-ended questions
- Use "boolean" type for yes/no toggles (vendorEvaluation, ajiDnaEnabled)
- Use "multiselect" type when offering predefined choices (provide options array)
- Make questions specific to the topic, not generic templates
- For DETAILED/COMPREHENSIVE topics: lead with the highest-leverage gap, not the most obvious dimension`;

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
      prompt: `Research topic (${parsed.data.topic.length} chars):
"""
${parsed.data.topic}
"""

Apply the topic-length tier (BRIEF/DETAILED/COMPREHENSIVE) and generate the appropriate number of questions per the system prompt rules. Skip any dimension the topic already covers. Lead with the highest-leverage gap.`,
    });

    return Response.json(result.object);
  } catch (err) {
    return Response.json(
      { error: "Question generation failed", detail: String(err) },
      { status: 500 },
    );
  }
}
