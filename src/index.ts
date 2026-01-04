/**
 * Compass Agent - AI Jury/Oracle
 *
 * Multi-AI consensus agent for trusted research.
 * First reference implementation of a PAP-compliant agent.
 *
 * Features:
 * - Multi-model querying (GPT-4, Claude, Gemini)
 * - Semantic similarity consensus calculation
 * - Shareable verdict reports
 * - PAP-RFC-001 compliant telemetry
 */

import { initializeHeartbeat } from './pap/heartbeat.js';
import { initializeMetrics } from './pap/metrics.js';
import { initializeLifecycle } from './pap/lifecycle.js';
import { initializeModelRouter } from './ai/model-router.js';
import { createServer, startServer } from './api/server.js';

// ============================================================================
// CONFIGURATION FROM ENVIRONMENT
// ============================================================================
//
// These environment variables are set by the PAP Station when deploying agents.
// For local development, create a .env file with these values.
//
// PAP CONNECTION:
// - PAP_STATION_URL: Station base URL (e.g., https://plugged.in)
// - PAP_AGENT_ID: Unique agent identifier assigned by Station
// - PAP_AGENT_KEY: Agent authentication key for Station communication
// - PAP_COLLECTOR_URL: Local heartbeat collector URL (optional, for in-cluster)
//
// MODEL ROUTER (LLM ACCESS):
// - MODEL_ROUTER_URL: URL of assigned Model Router service
//   Example: https://model-router.is.plugged.in
// - MODEL_ROUTER_TOKEN: JWT token for Model Router authentication
//   Issued by Station, can be revoked/regenerated from admin UI
//
// ============================================================================

const config = {
  // PAP Station connection
  stationUrl: process.env.PAP_STATION_URL || 'https://plugged.in',
  agentId: process.env.PAP_AGENT_ID || 'compass-local',
  apiKey: process.env.PAP_AGENT_KEY || '',
  // Local collector URL (for in-cluster heartbeat collection)
  collectorUrl: process.env.PAP_COLLECTOR_URL,

  // Model Router - JWT Token Authentication
  // The Model Router provides LLM access. Station issues a JWT token
  // that agents use for authentication. This decouples agents from
  // direct LLM API credentials.
  modelRouterUrl: process.env.MODEL_ROUTER_URL || '',
  modelRouterToken: process.env.MODEL_ROUTER_TOKEN || '',

  // Compass-specific configuration (from template configurable section)
  // COMPASS_MODELS: Comma-separated list of model IDs
  // Set by pluggedin-app based on user's template configuration
  compassModels: (process.env.COMPASS_MODELS || 'gpt-4o,claude-3-5-sonnet-20241022,gemini-1.5-flash')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean),

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || 'https://compass.plugged.in',
};

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  COMPASS AGENT - AI Jury/Oracle');
  console.log('  PAP-RFC-001 Compliant');
  console.log('='.repeat(60));
  console.log();

  // Initialize PAP lifecycle manager
  console.log('[Init] Initializing lifecycle manager...');
  const lifecycle = initializeLifecycle({
    stationUrl: config.stationUrl,
    agentId: config.agentId,
    apiKey: config.apiKey,
  });

  // Initialize PAP heartbeat emitter
  console.log('[Init] Initializing heartbeat emitter...');
  const heartbeat = initializeHeartbeat({
    stationUrl: config.stationUrl,
    agentId: config.agentId,
    apiKey: config.apiKey,
    collectorUrl: config.collectorUrl,
  });

  // Initialize PAP metrics collector
  console.log('[Init] Initializing metrics collector...');
  const metrics = initializeMetrics({
    stationUrl: config.stationUrl,
    agentId: config.agentId,
    apiKey: config.apiKey,
  });

  // Initialize Model Router client
  // The Model Router provides LLM access via JWT token authentication.
  // Token is issued by Station and can be revoked from admin UI.
  console.log('[Init] Initializing model router client...');
  if (config.modelRouterUrl && config.modelRouterToken) {
    initializeModelRouter({
      baseUrl: config.modelRouterUrl,
      agentId: config.agentId,
      token: config.modelRouterToken,
    });
    console.log(`[Init] Model Router: ${config.modelRouterUrl}`);
  } else {
    console.warn('[Init] Model Router not configured - MODEL_ROUTER_URL and MODEL_ROUTER_TOKEN required');
    console.warn('[Init] LLM features will not be available');
  }

  // Create HTTP server
  console.log('[Init] Creating HTTP server...');
  console.log(`[Init] Configured models: ${config.compassModels.join(', ')}`);
  const app = createServer({
    port: config.port,
    baseUrl: config.baseUrl,
    models: config.compassModels,
  });

  // Handle lifecycle state changes
  lifecycle.onStateChange((oldState, newState, reason) => {
    console.log(`[Lifecycle] ${oldState} → ${newState}: ${reason || 'No reason provided'}`);

    // Adjust heartbeat mode based on state
    if (newState === 'DRAINING') {
      heartbeat.setMode('EMERGENCY'); // More frequent during drain
    } else if (newState === 'ACTIVE') {
      heartbeat.setMode('IDLE');
    }
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, initiating graceful shutdown...`);

    // Enter draining state
    await lifecycle.drain(`Received ${signal}`);

    // Stop accepting new requests (server will 503)
    // Wait a bit for in-flight requests to complete
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Stop telemetry
    heartbeat.stop();
    metrics.stop();

    // Transition to terminated
    await lifecycle.terminate('Graceful shutdown complete');

    console.log('[Shutdown] Compass agent stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start services
  try {
    // Initialize lifecycle (NEW → PROVISIONED)
    await lifecycle.initialize();

    // Start HTTP server
    await startServer(app, config.port);

    // Start telemetry
    heartbeat.start();
    metrics.start();

    // Activate (PROVISIONED → ACTIVE)
    await lifecycle.activate();

    console.log();
    console.log('[Ready] Compass agent is operational');
    console.log(`[Ready] API: http://localhost:${config.port}`);
    console.log(`[Ready] Health: http://localhost:${config.port}/health`);
    console.log(`[Ready] Query: POST http://localhost:${config.port}/query`);
    console.log();
  } catch (error) {
    console.error('[Error] Failed to start Compass agent:', error);
    await lifecycle.kill('Startup failure');
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('[Fatal] Unhandled error:', error);
  process.exit(1);
});
