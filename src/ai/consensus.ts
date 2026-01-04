/**
 * Consensus Engine
 *
 * Calculates agreement between multiple AI model responses using
 * semantic similarity scoring.
 *
 * Verdict Types:
 * - UNANIMOUS: All models agree (score >= 0.9)
 * - SPLIT: Majority agrees (score >= 0.6 and < 0.9)
 * - NO_CONSENSUS: Significant disagreement (score < 0.6)
 */

import natural from 'natural';
import { getModelRouter } from './model-router.js';
import { getMetrics } from '../pap/metrics.js';

const TfIdf = natural.TfIdf;
const WordTokenizer = natural.WordTokenizer;
const tokenizer = new WordTokenizer();

// System prompt for jury-style responses
const JURY_SYSTEM_PROMPT = `You are participating in an AI Jury deliberation. Your role is to provide a thoughtful, well-reasoned answer to the user's question.

Guidelines:
1. Be concise but thorough
2. Provide your reasoning
3. If uncertain, express your confidence level
4. Focus on factual accuracy
5. Structure your response with:
   - A direct answer to the question
   - Brief supporting reasoning (2-3 key points)
   - Any important caveats or limitations

Remember: Your response will be compared with other AI models to reach a consensus verdict.`;

export interface ModelResponse {
  model: string;
  answer: string;
  reasoning?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export type VerdictType = 'unanimous' | 'split' | 'no_consensus';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ConsensusResult {
  verdict: VerdictType;
  confidence: ConfidenceLevel;
  agreementScore: number;
  responses: ModelResponse[];
  dissent?: ModelResponse;
  consensusAnswer?: string;
}

// Consensus thresholds
const THRESHOLDS = {
  UNANIMOUS: 0.9,    // >= 0.9 for unanimous
  SPLIT: 0.6,        // >= 0.6 and < 0.9 for split
  // < 0.6 for no_consensus
};

/**
 * Query all specified models in parallel
 */
export async function queryAllModels(
  question: string,
  models: string[] = ['gpt-4o', 'claude-3-5-sonnet-20241022', 'gemini-1.5-flash'],
  context?: string
): Promise<ModelResponse[]> {
  const router = getModelRouter();
  if (!router) {
    throw new Error('Model Router not initialized');
  }

  // Build user message with optional context
  const userMessage = context
    ? `Context: ${context}\n\nQuestion: ${question}`
    : question;

  // Query all models in parallel
  const promises = models.map(async (model): Promise<ModelResponse> => {
    const modelStartTime = Date.now();

    try {
      const response = await router.chat({
        model,
        messages: [
          { role: 'system', content: JURY_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3, // Lower temperature for consistency
        max_tokens: 2048,
      });

      const answer = response.choices[0]?.message?.content || '';

      return {
        model,
        answer,
        latencyMs: Date.now() - modelStartTime,
        success: true,
      };
    } catch (error) {
      console.error(`[Consensus] Model ${model} failed:`, error);
      return {
        model,
        answer: '',
        latencyMs: Date.now() - modelStartTime,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  const results = await Promise.all(promises);

  // Record metrics for each model
  const metrics = getMetrics();
  if (metrics) {
    for (const result of results) {
      metrics.recordQuery({
        success: result.success,
        latencyMs: result.latencyMs,
        modelResults: [
          {
            model: result.model,
            success: result.success,
            latencyMs: result.latencyMs,
          },
        ],
      });
    }
  }

  return results;
}

/**
 * Calculate semantic similarity between two text strings
 * Uses TF-IDF cosine similarity
 */
function calculateSimilarity(text1: string, text2: string): number {
  if (!text1 || !text2) return 0;

  // Tokenize and normalize
  const tokens1 = tokenizer.tokenize(text1.toLowerCase()) || [];
  const tokens2 = tokenizer.tokenize(text2.toLowerCase()) || [];

  if (tokens1.length === 0 || tokens2.length === 0) return 0;

  // Create TF-IDF instance
  const tfidf = new TfIdf();
  tfidf.addDocument(tokens1);
  tfidf.addDocument(tokens2);

  // Calculate term vectors
  const allTerms = new Set([...tokens1, ...tokens2]);
  const vector1: number[] = [];
  const vector2: number[] = [];

  for (const term of allTerms) {
    let score1 = 0;
    let score2 = 0;

    tfidf.tfidfs(term, (i, measure) => {
      if (i === 0) score1 = measure;
      if (i === 1) score2 = measure;
    });

    vector1.push(score1);
    vector2.push(score2);
  }

  // Cosine similarity
  const dotProduct = vector1.reduce((sum, val, i) => sum + val * vector2[i], 0);
  const magnitude1 = Math.sqrt(vector1.reduce((sum, val) => sum + val * val, 0));
  const magnitude2 = Math.sqrt(vector2.reduce((sum, val) => sum + val * val, 0));

  if (magnitude1 === 0 || magnitude2 === 0) return 0;

  return dotProduct / (magnitude1 * magnitude2);
}

/**
 * Calculate pairwise similarities between all responses
 */
function calculatePairwiseSimilarities(responses: ModelResponse[]): number[][] {
  const n = responses.length;
  const similarities: number[][] = Array(n)
    .fill(null)
    .map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        similarities[i][j] = 1;
      } else {
        const similarity = calculateSimilarity(
          responses[i].answer,
          responses[j].answer
        );
        similarities[i][j] = similarity;
        similarities[j][i] = similarity;
      }
    }
  }

  return similarities;
}

/**
 * Find the dissenting response (lowest average similarity)
 */
function findDissenter(
  responses: ModelResponse[],
  similarities: number[][]
): ModelResponse | null {
  if (responses.length < 2) return null;

  let minAvgSimilarity = Infinity;
  let dissenterIndex = -1;

  for (let i = 0; i < responses.length; i++) {
    // Calculate average similarity to other responses
    let sum = 0;
    let count = 0;

    for (let j = 0; j < responses.length; j++) {
      if (i !== j) {
        sum += similarities[i][j];
        count++;
      }
    }

    const avgSimilarity = count > 0 ? sum / count : 0;

    if (avgSimilarity < minAvgSimilarity) {
      minAvgSimilarity = avgSimilarity;
      dissenterIndex = i;
    }
  }

  return dissenterIndex >= 0 ? responses[dissenterIndex] : null;
}

/**
 * Get the majority answer (response with highest average similarity)
 */
function getMajorityAnswer(
  responses: ModelResponse[],
  similarities: number[][]
): string {
  if (responses.length === 0) return '';
  if (responses.length === 1) return responses[0].answer;

  let maxAvgSimilarity = -Infinity;
  let majorityIndex = 0;

  for (let i = 0; i < responses.length; i++) {
    let sum = 0;
    let count = 0;

    for (let j = 0; j < responses.length; j++) {
      if (i !== j) {
        sum += similarities[i][j];
        count++;
      }
    }

    const avgSimilarity = count > 0 ? sum / count : 0;

    if (avgSimilarity > maxAvgSimilarity) {
      maxAvgSimilarity = avgSimilarity;
      majorityIndex = i;
    }
  }

  return responses[majorityIndex].answer;
}

/**
 * Calculate consensus from model responses
 */
export function calculateConsensus(responses: ModelResponse[]): ConsensusResult {
  // Filter successful responses
  const successfulResponses = responses.filter(r => r.success && r.answer);

  if (successfulResponses.length === 0) {
    return {
      verdict: 'no_consensus',
      confidence: 'low',
      agreementScore: 0,
      responses,
    };
  }

  if (successfulResponses.length === 1) {
    return {
      verdict: 'no_consensus',
      confidence: 'low',
      agreementScore: 0,
      responses,
      consensusAnswer: successfulResponses[0].answer,
    };
  }

  // Calculate pairwise similarities
  const similarities = calculatePairwiseSimilarities(successfulResponses);

  // Calculate average agreement score
  let totalSimilarity = 0;
  let pairCount = 0;

  for (let i = 0; i < successfulResponses.length; i++) {
    for (let j = i + 1; j < successfulResponses.length; j++) {
      totalSimilarity += similarities[i][j];
      pairCount++;
    }
  }

  const agreementScore = pairCount > 0 ? totalSimilarity / pairCount : 0;

  // Determine verdict and confidence
  let verdict: VerdictType;
  let confidence: ConfidenceLevel;

  if (agreementScore >= THRESHOLDS.UNANIMOUS) {
    verdict = 'unanimous';
    confidence = 'high';
  } else if (agreementScore >= THRESHOLDS.SPLIT) {
    verdict = 'split';
    confidence = 'medium';
  } else {
    verdict = 'no_consensus';
    confidence = 'low';
  }

  // Find consensus answer and dissent
  const consensusAnswer = getMajorityAnswer(successfulResponses, similarities);
  const dissent = verdict === 'split' ? findDissenter(successfulResponses, similarities) ?? undefined : undefined;

  return {
    verdict,
    confidence,
    agreementScore: Math.round(agreementScore * 100) / 100,
    responses,
    consensusAnswer,
    dissent,
  };
}

/**
 * Execute a complete jury query
 */
export async function executeJuryQuery(params: {
  question: string;
  context?: string;
  models?: string[];
}): Promise<ConsensusResult> {
  const { question, context, models } = params;

  // Query all models
  const responses = await queryAllModels(question, models, context);

  // Calculate consensus
  const result = calculateConsensus(responses);

  // Record overall query metrics
  const metrics = getMetrics();
  if (metrics) {
    metrics.recordQuery({
      success: result.verdict !== 'no_consensus' || responses.some(r => r.success),
      latencyMs: Math.max(...responses.map(r => r.latencyMs)), // Use max for parallel queries
      verdict: result.verdict,
    });
  }

  return result;
}
