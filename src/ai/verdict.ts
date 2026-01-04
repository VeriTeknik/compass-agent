/**
 * Verdict Formatter
 *
 * Formats consensus results into shareable, user-friendly reports.
 * Optimized for social sharing (Twitter cards, LinkedIn, etc.)
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ConsensusResult,
  VerdictType,
  ConfidenceLevel,
} from './consensus.js';

export interface VerdictResponse {
  model: string;
  answer: string;
  reasoning?: string;
}

export interface VerdictDissent {
  model: string;
  answer: string;
  reasoning?: string;
}

export interface VerdictReport {
  id: string;
  question: string;
  verdict: VerdictType;
  confidence: ConfidenceLevel;
  agreementScore: number;

  // Individual model responses
  responses: VerdictResponse[];

  // Consensus answer (majority view)
  consensusAnswer: string | null;

  // Dissenting opinion (if split verdict)
  dissent: VerdictDissent | null;

  // Metadata
  timestamp: string;
  modelsQueried: string[];
  successfulModels: string[];
  failedModels: string[];

  // For social sharing
  shareableUrl: string;
  summary: string;
}

// Helper to truncate text for summaries
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// Generate verdict emoji based on result
function getVerdictEmoji(verdict: VerdictType): string {
  switch (verdict) {
    case 'unanimous':
      return '✓✓✓'; // All agree
    case 'split':
      return '✓✓✗'; // 2-1 split
    case 'no_consensus':
      return '✗✗✗'; // No agreement
  }
}

// Generate confidence badge
function getConfidenceBadge(confidence: ConfidenceLevel): string {
  switch (confidence) {
    case 'high':
      return '🟢 High Confidence';
    case 'medium':
      return '🟡 Medium Confidence';
    case 'low':
      return '🔴 Low Confidence';
  }
}

// Generate human-readable verdict description
function getVerdictDescription(
  verdict: VerdictType,
  agreementScore: number,
  models: string[]
): string {
  const score = Math.round(agreementScore * 100);
  const modelCount = models.length;

  switch (verdict) {
    case 'unanimous':
      return `All ${modelCount} AI models agree (${score}% consensus)`;
    case 'split':
      return `${modelCount - 1} of ${modelCount} AI models agree (${score}% consensus)`;
    case 'no_consensus':
      return `AI models disagree significantly (${score}% agreement)`;
  }
}

/**
 * Format consensus result into a shareable verdict report
 */
export function formatVerdict(
  result: ConsensusResult,
  question: string,
  baseUrl: string = 'https://compass.plugged.in'
): VerdictReport {
  const id = uuidv4();
  const timestamp = new Date().toISOString();

  // Categorize models
  const modelsQueried = result.responses.map(r => r.model);
  const successfulModels = result.responses
    .filter(r => r.success)
    .map(r => r.model);
  const failedModels = result.responses
    .filter(r => !r.success)
    .map(r => r.model);

  // Format individual responses
  const responses: VerdictResponse[] = result.responses
    .filter(r => r.success)
    .map(r => ({
      model: r.model,
      answer: r.answer,
      reasoning: r.reasoning,
    }));

  // Format dissent if present
  const dissent: VerdictDissent | null = result.dissent
    ? {
        model: result.dissent.model,
        answer: result.dissent.answer,
        reasoning: result.dissent.reasoning,
      }
    : null;

  // Generate summary for social sharing
  const verdictEmoji = getVerdictEmoji(result.verdict);
  const summary = `${verdictEmoji} ${getVerdictDescription(
    result.verdict,
    result.agreementScore,
    successfulModels
  )}`;

  return {
    id,
    question,
    verdict: result.verdict,
    confidence: result.confidence,
    agreementScore: result.agreementScore,
    responses,
    consensusAnswer: result.consensusAnswer || null,
    dissent,
    timestamp,
    modelsQueried,
    successfulModels,
    failedModels,
    shareableUrl: `${baseUrl}/v/${id}`,
    summary,
  };
}

/**
 * Generate a Twitter-optimized summary (max 280 chars)
 */
export function formatForTwitter(report: VerdictReport): string {
  const emoji = getVerdictEmoji(report.verdict);
  const scorePercent = Math.round(report.agreementScore * 100);

  let tweet = `${emoji} AI Jury Verdict: `;

  if (report.verdict === 'unanimous') {
    tweet += `UNANIMOUS (${scorePercent}% agreement)\n\n`;
  } else if (report.verdict === 'split') {
    tweet += `SPLIT ${report.successfulModels.length - 1}-1 (${scorePercent}%)\n\n`;
  } else {
    tweet += `NO CONSENSUS (${scorePercent}%)\n\n`;
  }

  // Add truncated question
  const questionPrefix = 'Q: ';
  const maxQuestionLen = 100;
  tweet += questionPrefix + truncate(report.question, maxQuestionLen) + '\n\n';

  // Add truncated answer
  if (report.consensusAnswer) {
    const answerPrefix = 'A: ';
    const remainingChars = 280 - tweet.length - answerPrefix.length - 30; // Reserve for URL
    tweet += answerPrefix + truncate(report.consensusAnswer, remainingChars);
  }

  // Add URL
  tweet += `\n\n${report.shareableUrl}`;

  return tweet.slice(0, 280);
}

/**
 * Generate a detailed Markdown report
 */
export function formatAsMarkdown(report: VerdictReport): string {
  const emoji = getVerdictEmoji(report.verdict);
  const badge = getConfidenceBadge(report.confidence);

  let md = `# ${emoji} AI Jury Verdict\n\n`;
  md += `**${badge}**\n\n`;
  md += `---\n\n`;
  md += `## Question\n\n${report.question}\n\n`;

  // Consensus answer
  if (report.consensusAnswer) {
    md += `## Consensus Answer\n\n${report.consensusAnswer}\n\n`;
  }

  // Individual responses
  md += `## Individual AI Responses\n\n`;
  for (const response of report.responses) {
    md += `### ${response.model}\n\n`;
    md += `${response.answer}\n\n`;
  }

  // Dissenting opinion
  if (report.dissent) {
    md += `## Dissenting Opinion\n\n`;
    md += `**${report.dissent.model}** disagrees:\n\n`;
    md += `${report.dissent.answer}\n\n`;
  }

  // Metadata
  md += `---\n\n`;
  md += `**Agreement Score**: ${Math.round(report.agreementScore * 100)}%\n\n`;
  md += `**Models Queried**: ${report.modelsQueried.join(', ')}\n\n`;

  if (report.failedModels.length > 0) {
    md += `**Failed Models**: ${report.failedModels.join(', ')}\n\n`;
  }

  md += `**Timestamp**: ${report.timestamp}\n\n`;
  md += `**Share**: [${report.shareableUrl}](${report.shareableUrl})\n`;

  return md;
}

/**
 * Generate a JSON-LD structured data for SEO
 */
export function formatAsJsonLd(report: VerdictReport): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `AI Jury Verdict: ${truncate(report.question, 100)}`,
    description: report.summary,
    datePublished: report.timestamp,
    author: {
      '@type': 'Organization',
      name: 'Compass by Plugged.in',
    },
    mainEntity: {
      '@type': 'Question',
      name: report.question,
      acceptedAnswer: report.consensusAnswer
        ? {
            '@type': 'Answer',
            text: report.consensusAnswer,
            upvoteCount: Math.round(report.agreementScore * 100),
          }
        : undefined,
    },
  };
}
