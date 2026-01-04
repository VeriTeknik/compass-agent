/**
 * Compass Agent HTTP Server
 *
 * Provides REST API endpoints for:
 * - /query - Execute jury queries
 * - /health - PAP health check
 * - /status - Agent status and model availability
 */

import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { z } from 'zod';

import { getLifecycle } from '../pap/lifecycle.js';
import { getHeartbeat } from '../pap/heartbeat.js';
import { getMetrics } from '../pap/metrics.js';
import { getModelRouter } from '../ai/model-router.js';
import { executeJuryQuery, GuardrailError } from '../ai/consensus.js';
import { formatVerdict, formatForTwitter, formatAsMarkdown } from '../ai/verdict.js';
import { getMemoryManager, getMemoryStats, cleanupExpiredSessions } from '../ai/memory.js';

// Request validation schemas
const QueryRequestSchema = z.object({
  question: z.string().min(1).max(10000),
  context: z.string().max(50000).optional(),
  models: z.array(z.string()).min(1).max(10).optional(),
  format: z.enum(['json', 'twitter', 'markdown']).optional(),
});

// Chat API schema (simpler interface for UI)
const ChatRequestSchema = z.object({
  message: z.string().min(1).max(10000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});

export interface ServerConfig {
  port: number;
  baseUrl?: string;
  models?: string[];  // Configured models from COMPASS_MODELS env var
}

export function createServer(config: ServerConfig): Application {
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Error handling middleware
  const errorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Server] Error:', err);

    // Handle guardrail errors specifically
    if (err instanceof GuardrailError) {
      res.status(400).json({
        error: {
          code: 'GUARDRAIL_BLOCKED',
          message: err.message,
          reason: err.reason,
          riskLevel: err.riskLevel,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error',
      },
    });
  };

  // Start periodic session cleanup (every 5 minutes)
  setInterval(() => {
    const cleaned = cleanupExpiredSessions();
    if (cleaned > 0) {
      console.log(`[Server] Cleaned up ${cleaned} expired sessions`);
    }
  }, 5 * 60 * 1000);

  // Health endpoint (PAP compliant)
  app.get('/health', (_req: Request, res: Response) => {
    const heartbeat = getHeartbeat();
    const lifecycle = getLifecycle();

    const isHealthy = heartbeat?.isHealthy() ?? false;
    const state = lifecycle?.getState() ?? 'UNKNOWN';

    if (!isHealthy || state === 'KILLED' || state === 'TERMINATED') {
      res.status(503).json({
        status: 'unhealthy',
        state,
        uptime: heartbeat?.getUptimeSeconds() ?? 0,
      });
      return;
    }

    res.json({
      status: 'healthy',
      state,
      uptime: heartbeat?.getUptimeSeconds() ?? 0,
    });
  });

  // Status endpoint (PAP compliant)
  app.get('/status', async (_req: Request, res: Response) => {
    const lifecycle = getLifecycle();
    const heartbeat = getHeartbeat();
    const metrics = getMetrics();
    const router = getModelRouter();

    // Check model availability
    let modelStatus: Record<string, boolean> = {};
    if (router) {
      try {
        const models = await router.listModels();
        modelStatus = models.reduce(
          (acc, m) => ({ ...acc, [m.id]: true }),
          {}
        );
      } catch {
        modelStatus = {};
      }
    }

    res.json({
      state: lifecycle?.getState() ?? 'UNKNOWN',
      mode: heartbeat?.getMode() ?? 'UNKNOWN',
      uptime_seconds: heartbeat?.getUptimeSeconds() ?? 0,
      metrics: metrics?.getMetrics() ?? null,
      configured_models: config.models ?? [],  // Models configured via COMPASS_MODELS env
      available_models: modelStatus,           // Models available on the router
    });
  });

  // Query endpoint - main Compass functionality
  app.post('/query', async (req: Request, res: Response, next: NextFunction) => {
    const lifecycle = getLifecycle();
    const metricsCollector = getMetrics();

    // Check if agent is operational
    if (!lifecycle?.isOperational()) {
      res.status(503).json({
        error: {
          code: 'AGENT_NOT_OPERATIONAL',
          message: `Agent is in ${lifecycle?.getState() ?? 'UNKNOWN'} state`,
        },
      });
      return;
    }

    try {
      // Validate request
      const parseResult = QueryRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: parseResult.error.issues,
          },
        });
        return;
      }

      const { question, context, models: requestModels, format } = parseResult.data;

      // Extract session ID from header (or undefined for stateless query)
      const sessionId = req.headers['x-session-id'] as string | undefined;

      // Increment request counter
      metricsCollector?.incrementRequests();

      // Use request models if provided, otherwise use configured models from env
      const modelsToUse = requestModels && requestModels.length > 0
        ? requestModels
        : config.models;

      // Execute jury query with session support
      const result = await executeJuryQuery({
        question,
        context,
        models: modelsToUse,
        sessionId,
      });

      // Format verdict
      const report = formatVerdict(result, question, config.baseUrl);

      // Return in requested format
      switch (format) {
        case 'twitter':
          res.json({
            ...report,
            formatted: formatForTwitter(report),
          });
          break;

        case 'markdown':
          res.type('text/markdown').send(formatAsMarkdown(report));
          break;

        case 'json':
        default:
          res.json(report);
          break;
      }
    } catch (error) {
      next(error);
    }
  });

  // Models endpoint - list available models
  app.get('/models', async (_req: Request, res: Response) => {
    const router = getModelRouter();
    if (!router) {
      res.status(503).json({
        error: {
          code: 'ROUTER_NOT_INITIALIZED',
          message: 'Model router not available',
        },
      });
      return;
    }

    try {
      const models = await router.listModels();
      res.json({ models });
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'MODEL_LIST_ERROR',
          message: error instanceof Error ? error.message : 'Failed to list models',
        },
      });
    }
  });

  // Metrics endpoint (for monitoring)
  app.get('/metrics', (_req: Request, res: Response) => {
    const metrics = getMetrics();
    if (!metrics) {
      res.status(503).json({
        error: {
          code: 'METRICS_NOT_AVAILABLE',
          message: 'Metrics collector not initialized',
        },
      });
      return;
    }

    const data = metrics.getMetrics();

    // Format as Prometheus-style metrics
    const prometheusFormat = `
# HELP compass_queries_total Total number of queries processed
# TYPE compass_queries_total counter
compass_queries_total ${data.totalQueries}

# HELP compass_queries_successful_total Successful queries
# TYPE compass_queries_successful_total counter
compass_queries_successful_total ${data.successfulQueries}

# HELP compass_queries_failed_total Failed queries
# TYPE compass_queries_failed_total counter
compass_queries_failed_total ${data.failedQueries}

# HELP compass_requests_total Total HTTP requests handled
# TYPE compass_requests_total counter
compass_requests_total ${data.requestCount}

# HELP compass_consensus_unanimous_total Unanimous verdicts
# TYPE compass_consensus_unanimous_total counter
compass_consensus_unanimous_total ${data.consensusResults.unanimous}

# HELP compass_consensus_split_total Split verdicts
# TYPE compass_consensus_split_total counter
compass_consensus_split_total ${data.consensusResults.split}

# HELP compass_consensus_no_consensus_total No consensus verdicts
# TYPE compass_consensus_no_consensus_total counter
compass_consensus_no_consensus_total ${data.consensusResults.no_consensus}
`.trim();

    res.type('text/plain').send(prometheusFormat);
  });

  // Chat endpoint - simplified interface for UI
  app.post('/api/chat', async (req: Request, res: Response, next: NextFunction) => {
    const lifecycle = getLifecycle();
    const metricsCollector = getMetrics();

    // Check if agent is operational
    if (!lifecycle?.isOperational()) {
      res.status(503).json({
        error: {
          code: 'AGENT_NOT_OPERATIONAL',
          message: `Agent is in ${lifecycle?.getState() ?? 'UNKNOWN'} state`,
        },
      });
      return;
    }

    try {
      // Validate request
      const parseResult = ChatRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: parseResult.error.issues,
          },
        });
        return;
      }

      const { message, history } = parseResult.data;

      // Extract session ID from header (or undefined for stateless chat)
      const sessionId = req.headers['x-session-id'] as string | undefined;

      // Build context from history (memory will also add conversation context)
      const context = history
        ?.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
        .join('\n\n');

      // Increment request counter
      metricsCollector?.incrementRequests();

      // Execute jury query with session support
      const result = await executeJuryQuery({
        question: message,
        context: context || undefined,
        models: config.models,
        sessionId,
      });

      // Format verdict
      const report = formatVerdict(result, message, config.baseUrl);

      // Return simplified response for chat
      res.json({
        response: report.consensusAnswer || report.summary || 'I was unable to generate a response.',
        consensus: {
          verdict: report.verdict,
          confidence: report.confidence,
          agreementScore: report.agreementScore,
        },
        models_used: report.successfulModels || [],
        // Include individual model responses for UI to display
        model_responses: report.responses || [],
        failed_models: report.failedModels || [],
      // Include session info if available
      session_id: result.sessionId,
      memory_context_used: result.memoryContextUsed,
      reflection_applied: result.reflectionApplied,
      quality_score: result.qualityScore,
      });
    } catch (error) {
      next(error);
    }
  });

  // Session history endpoint - get conversation history for a session
  app.get('/api/chat/history/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params;

    if (!sessionId) {
      res.status(400).json({
        error: {
          code: 'MISSING_SESSION_ID',
          message: 'Session ID is required',
        },
      });
      return;
    }

    const memoryManager = getMemoryManager(sessionId);
    const history = memoryManager.getSessionHistory();

    res.json({
      session_id: sessionId,
      query_count: history.length,
      queries: history.map(entry => ({
        id: entry.id,
        question: entry.question,
        answer: entry.consensusAnswer,
        verdict: entry.verdict,
        agreement_score: entry.agreementScore,
        timestamp: entry.timestamp.toISOString(),
      })),
    });
  });

  // Memory stats endpoint - for monitoring
  app.get('/api/memory/stats', (_req: Request, res: Response) => {
    const stats = getMemoryStats();
    res.json({
      active_sessions: stats.activeSessions,
      total_session_queries: stats.totalSessionQueries,
      long_term_memory_size: stats.longTermMemorySize,
    });
  });

  // Serve static frontend files
  // In production, dist/public is next to dist/api, so we go up one level and into public
  const publicPath = path.resolve(process.cwd(), 'dist', 'public');
  app.use(express.static(publicPath));

  // SPA fallback - serve index.html for non-API routes
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    // Skip API routes, health checks, and new endpoints
    if (req.path.startsWith('/api') ||
        req.path === '/health' ||
        req.path === '/status' ||
        req.path === '/query' ||
        req.path === '/models' ||
        req.path === '/metrics') {
      next();
      return;
    }

    const indexPath = path.join(publicPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        // If index.html doesn't exist, continue to 404
        next();
      }
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
    });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}

export function startServer(app: Application, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`[Server] Compass agent listening on port ${port}`);
      resolve();
    });

    server.on('error', reject);
  });
}
