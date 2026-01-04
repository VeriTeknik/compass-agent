/**
 * Reflection Module
 *
 * Implements the Reflection Pattern for answer quality improvement.
 * A "Critic Agent" evaluates the consensus answer before returning
 * it to users, identifying issues and generating refined versions.
 */

import { getModelRouter } from './model-router.js';
import type { ModelResponse } from './consensus.js';

export interface ReflectionResult {
  originalAnswer: string;
  critique: string;
  refinedAnswer: string;
  qualityScore: number; // 0-100
  issues: string[];
}

// Critic prompt template
const CRITIC_PROMPT = `You are a critical reviewer evaluating an AI-generated answer from a multi-model consensus system.

CONSENSUS ANSWER TO REVIEW:
{answer}

ORIGINAL QUESTION:
{question}

INDIVIDUAL MODEL RESPONSES:
{responses}

Evaluate this consensus answer for:
1. **Factual accuracy** - Are there any claims that contradict the individual responses or seem incorrect?
2. **Completeness** - Does it capture the key points from all agreeing models?
3. **Clarity** - Is the answer well-structured and easy to understand?
4. **Hedging appropriateness** - Are uncertainty levels properly communicated?

Provide your evaluation as ONLY valid JSON (no markdown code blocks, no explanation outside JSON):
{
  "qualityScore": <number 0-100>,
  "issues": ["issue1", "issue2"],
  "refinedAnswer": "<improved version that addresses the issues, or the original if no improvements needed>"
}

Guidelines for scoring:
- 90-100: Excellent - accurate, complete, clear, appropriate hedging
- 70-89: Good - minor issues that don't significantly affect quality
- 50-69: Fair - noticeable issues but still useful
- Below 50: Poor - significant problems that undermine usefulness`;

/**
 * Reflect on consensus answer and potentially improve it
 */
export async function reflectOnConsensus(
  question: string,
  consensusAnswer: string,
  modelResponses: ModelResponse[]
): Promise<ReflectionResult> {
  const router = getModelRouter();

  if (!router) {
    // Return original answer if router unavailable
    return {
      originalAnswer: consensusAnswer,
      critique: 'Reflection unavailable - model router not initialized',
      refinedAnswer: consensusAnswer,
      qualityScore: 0,
      issues: ['Unable to perform reflection'],
    };
  }

  // Format model responses for the prompt
  const responsesFormatted = modelResponses
    .filter(r => r.success && r.answer)
    .map(r => `[${r.model}]: ${r.answer.slice(0, 1000)}`)
    .join('\n\n');

  // Build the critic prompt
  const prompt = CRITIC_PROMPT
    .replace('{answer}', consensusAnswer)
    .replace('{question}', question)
    .replace('{responses}', responsesFormatted);

  // Get the reflection model from env or use default
  const reflectionModel = process.env.REFLECTION_MODEL || 'claude-3-5-sonnet-20241022';

  try {
    const response = await router.chat({
      model: reflectionModel,
      messages: [
        { role: 'system', content: 'You are a meticulous answer quality reviewer. Respond only with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2, // Low temperature for consistent evaluation
      max_tokens: 2048,
    });

    const content = response.choices[0]?.message?.content || '';

    // Parse JSON response, handling potential markdown code blocks
    let jsonContent = content;
    if (content.includes('```json')) {
      jsonContent = content.split('```json')[1].split('```')[0].trim();
    } else if (content.includes('```')) {
      jsonContent = content.split('```')[1].split('```')[0].trim();
    }

    const critique = JSON.parse(jsonContent);

    return {
      originalAnswer: consensusAnswer,
      critique: content,
      refinedAnswer: critique.refinedAnswer || consensusAnswer,
      qualityScore: typeof critique.qualityScore === 'number' ? critique.qualityScore : 50,
      issues: Array.isArray(critique.issues) ? critique.issues : [],
    };
  } catch (error) {
    console.error('[Reflection] Failed to reflect on consensus:', error);

    // Return original answer on error
    return {
      originalAnswer: consensusAnswer,
      critique: `Reflection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      refinedAnswer: consensusAnswer,
      qualityScore: 0,
      issues: ['Reflection process failed'],
    };
  }
}

/**
 * Determine if reflection should be applied based on verdict
 */
export function shouldApplyReflection(
  verdict: 'unanimous' | 'split' | 'no_consensus',
  consensusAnswer?: string
): boolean {
  // Don't reflect if there's no consensus answer
  if (!consensusAnswer) return false;

  // Don't reflect on no_consensus (nothing to improve)
  if (verdict === 'no_consensus') return false;

  // Reflect on unanimous and split verdicts
  return true;
}

/**
 * Check if reflection is enabled via environment variable
 */
export function isReflectionEnabled(): boolean {
  return process.env.ENABLE_REFLECTION !== 'false';
}

/**
 * Quality threshold for using refined answer
 * If quality score is above this, use the refined answer
 */
export const QUALITY_THRESHOLD = 70;
