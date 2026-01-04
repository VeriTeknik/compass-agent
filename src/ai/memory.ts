/**
 * Memory Management Module
 *
 * Implements the Memory Management Pattern for session continuity
 * and learning from past queries.
 *
 * Memory Types:
 * - Session Memory: Short-term, per-session context (last 10 queries)
 * - Long-term Memory: High-quality verdicts for similar query lookup
 */

import { v4 as uuidv4 } from 'uuid';
import type { VerdictType } from './consensus.js';

export interface MemoryEntry {
  id: string;
  question: string;
  consensusAnswer: string;
  verdict: VerdictType;
  agreementScore: number;
  timestamp: Date;
}

export interface SessionMemory {
  sessionId: string;
  queries: MemoryEntry[];
  createdAt: Date;
  lastAccessedAt: Date;
}

// Configuration
const MAX_SESSION_QUERIES = 10;
const CONTEXT_QUERIES_COUNT = 3;
const LONG_TERM_QUALITY_THRESHOLD = 0.8;

// In-memory storage (replace with Redis/PostgreSQL in production)
const sessionStore = new Map<string, SessionMemory>();
const longTermMemory: MemoryEntry[] = [];

// Memory managers cache
const memoryManagerCache = new Map<string, MemoryManager>();

/**
 * Memory Manager for session and long-term memory operations
 */
export class MemoryManager {
  private sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId || uuidv4();

    // Initialize session if it doesn't exist
    if (!sessionStore.has(this.sessionId)) {
      sessionStore.set(this.sessionId, {
        sessionId: this.sessionId,
        queries: [],
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      });
    }
  }

  /**
   * Get the session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Add a query result to session memory
   */
  addToSession(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): void {
    const session = sessionStore.get(this.sessionId);
    if (!session) return;

    const fullEntry: MemoryEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date(),
    };

    session.queries.push(fullEntry);
    session.lastAccessedAt = new Date();

    // Keep only last N queries in session
    if (session.queries.length > MAX_SESSION_QUERIES) {
      session.queries.shift();
    }

    // Also save to long-term if high quality
    this.saveToLongTerm(fullEntry);
  }

  /**
   * Get conversation context from recent queries
   * Returns formatted string of last N queries for context
   */
  getConversationContext(): string {
    const session = sessionStore.get(this.sessionId);
    if (!session || session.queries.length === 0) {
      return '';
    }

    // Get last N queries
    const recentQueries = session.queries.slice(-CONTEXT_QUERIES_COUNT);

    if (recentQueries.length === 0) {
      return '';
    }

    const context = recentQueries
      .map(q => `Q: ${q.question}\nA: ${q.consensusAnswer}`)
      .join('\n\n');

    return `Previous conversation context:\n${context}`;
  }

  /**
   * Get all queries in the current session
   */
  getSessionHistory(): MemoryEntry[] {
    const session = sessionStore.get(this.sessionId);
    return session ? [...session.queries] : [];
  }

  /**
   * Find similar queries from long-term memory
   * Uses simple keyword matching (replace with embeddings in production)
   */
  findSimilarQueries(question: string, limit: number = 5): MemoryEntry[] {
    // Extract keywords (words longer than 3 chars)
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
      .map(w => w.replace(/[^a-z0-9]/g, ''));

    if (keywords.length === 0) {
      return [];
    }

    // Score each long-term memory entry by keyword match
    const scored = longTermMemory
      .map(entry => {
        const entryLower = entry.question.toLowerCase();
        const matchCount = keywords.filter(kw => entryLower.includes(kw)).length;
        return { entry, score: matchCount / keywords.length };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(item => item.entry);
  }

  /**
   * Save high-quality verdicts to long-term memory
   */
  saveToLongTerm(entry: MemoryEntry): void {
    // Only save high-confidence results
    if (entry.agreementScore >= LONG_TERM_QUALITY_THRESHOLD && entry.verdict !== 'no_consensus') {
      // Check for duplicates (same question, similar answer)
      const isDuplicate = longTermMemory.some(
        existing =>
          existing.question.toLowerCase() === entry.question.toLowerCase()
      );

      if (!isDuplicate) {
        longTermMemory.push(entry);

        // Keep long-term memory bounded (optional, for memory management)
        if (longTermMemory.length > 1000) {
          longTermMemory.shift();
        }
      }
    }
  }

  /**
   * Clear the current session
   */
  clearSession(): void {
    const session = sessionStore.get(this.sessionId);
    if (session) {
      session.queries = [];
      session.lastAccessedAt = new Date();
    }
  }
}

/**
 * Get or create a memory manager for a session
 */
export function getMemoryManager(sessionId?: string): MemoryManager {
  // If no sessionId provided, create a new one
  if (!sessionId) {
    return new MemoryManager();
  }

  // Return cached manager or create new one
  if (!memoryManagerCache.has(sessionId)) {
    memoryManagerCache.set(sessionId, new MemoryManager(sessionId));
  }

  return memoryManagerCache.get(sessionId)!;
}

/**
 * Check if memory is enabled via environment variable
 */
export function isMemoryEnabled(): boolean {
  return process.env.ENABLE_MEMORY !== 'false';
}

/**
 * Clean up expired sessions (call periodically)
 * Sessions older than SESSION_TTL_SECONDS are removed
 */
export function cleanupExpiredSessions(): number {
  const ttlSeconds = parseInt(process.env.SESSION_TTL_SECONDS || '3600', 10);
  const now = new Date();
  let cleanedCount = 0;

  for (const [sessionId, session] of sessionStore.entries()) {
    const ageMs = now.getTime() - session.lastAccessedAt.getTime();
    if (ageMs > ttlSeconds * 1000) {
      sessionStore.delete(sessionId);
      memoryManagerCache.delete(sessionId);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

/**
 * Get memory statistics (for monitoring)
 */
export function getMemoryStats(): {
  activeSessions: number;
  totalSessionQueries: number;
  longTermMemorySize: number;
} {
  let totalSessionQueries = 0;
  for (const session of sessionStore.values()) {
    totalSessionQueries += session.queries.length;
  }

  return {
    activeSessions: sessionStore.size,
    totalSessionQueries,
    longTermMemorySize: longTermMemory.length,
  };
}
