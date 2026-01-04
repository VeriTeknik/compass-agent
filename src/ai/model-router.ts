/**
 * Model Router Client
 *
 * ============================================================================
 * PAP MODEL ROUTER INTEGRATION
 * ============================================================================
 *
 * This client connects to a PAP Model Router service for LLM access.
 * Agents NEVER call LLM provider APIs directly - they go through the Model Router.
 *
 * ARCHITECTURE:
 * ┌─────────────┐      JWT Token      ┌──────────────────┐      API Keys     ┌──────────────┐
 * │   Agent     │ ──────────────────> │  Model Router    │ ────────────────> │  LLM APIs    │
 * │ (Compass)   │                     │  (per-region)    │                   │ (OpenAI etc) │
 * └─────────────┘                     └──────────────────┘                   └──────────────┘
 *
 * BENEFITS:
 * - Centralized credential management (API keys only on Model Router)
 * - Usage tracking and billing per agent
 * - Rate limiting and quota enforcement
 * - Automatic failover and retry logic
 * - Token revocation for security
 *
 * ENVIRONMENT VARIABLES:
 * - MODEL_ROUTER_URL: URL of the assigned Model Router service
 *   Example: https://model-router.is.plugged.in
 *
 * - MODEL_ROUTER_TOKEN: JWT token for authentication (issued by Station)
 *   Example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *
 * TOKEN LIFECYCLE:
 * 1. Station generates JWT token when agent is created
 * 2. Token contains agent ID, name, and expiration
 * 3. Token can be revoked/regenerated from Station admin UI
 * 4. If revoked, agent receives 401 and should alert operators
 *
 * REPLICATION GUIDE:
 * To implement Model Router auth in your own agent:
 * 1. Copy this file to your agent's source
 * 2. Set MODEL_ROUTER_URL and MODEL_ROUTER_TOKEN env vars
 * 3. Call initializeModelRouter() at startup
 * 4. Use getModelRouter().chat() for LLM requests
 * ============================================================================
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * PAP metadata returned by the Model Router
 * Contains billing and performance information
 */
export interface PAPMetadata {
  cost_usd: number;
  latency_ms: number;
  provider: string;
  cached: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage: UsageInfo;
  pap_metadata: PAPMetadata;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  context_length: number;
  pricing: {
    input_per_1k: number;
    output_per_1k: number;
  };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Model Router client configuration
 *
 * IMPORTANT: Use environment variables, not hardcoded values!
 * These are set by the Station when deploying the agent.
 */
interface ModelRouterConfig {
  /** Model Router service URL (from MODEL_ROUTER_URL env var) */
  baseUrl: string;

  /** Agent UUID for tracking (from PAP_AGENT_ID env var) */
  agentId: string;

  /** JWT token for authentication (from MODEL_ROUTER_TOKEN env var) */
  token: string;

  /** Request timeout in milliseconds (default: 60000) */
  timeout?: number;

  /** Number of retry attempts (default: 2) */
  retries?: number;

  /** Base delay between retries in ms (default: 1000) */
  retryDelay?: number;
}

// ============================================================================
// MODEL ROUTER CLIENT
// ============================================================================

export class ModelRouterClient {
  private baseUrl: string;
  private agentId: string;
  private token: string;
  private timeout: number;
  private retries: number;
  private retryDelay: number;

  constructor(config: ModelRouterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.agentId = config.agentId;
    this.token = config.token;
    this.timeout = config.timeout ?? 60000; // 60 seconds default
    this.retries = config.retries ?? 2;
    this.retryDelay = config.retryDelay ?? 1000;

    // Validate configuration
    if (!this.baseUrl) {
      throw new Error('MODEL_ROUTER_URL is required');
    }
    if (!this.token) {
      throw new Error('MODEL_ROUTER_TOKEN is required');
    }
  }

  /**
   * Send a chat completion request through the Model Router
   *
   * This is the main method for LLM interactions.
   * The Model Router handles provider selection, rate limiting, and billing.
   *
   * @example
   * const response = await modelRouter.chat({
   *   model: 'gpt-4o',  // or 'claude-3-5-sonnet-20241022', 'gemini-1.5-pro', etc.
   *   messages: [
   *     { role: 'system', content: 'You are a helpful assistant.' },
   *     { role: 'user', content: 'Hello!' }
   *   ],
   *   temperature: 0.7,
   *   max_tokens: 1000,
   * });
   */
  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const requestId = uuidv4();
    const startTime = Date.now();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const { data, headers } = await this.makeRequest(
          '/v1/chat/completions',  // Model Router endpoint (not /api/v1/...)
          {
            ...request,
            stream: false, // Non-streaming for now
          },
          requestId
        );

        // Extract PAP metadata from response headers
        const papMetadata: PAPMetadata = {
          cost_usd: parseFloat(headers.get('X-Request-Cost') || '0'),
          latency_ms: parseInt(headers.get('X-Request-Latency-Ms') || '0') || (Date.now() - startTime),
          provider: headers.get('X-Model-Provider') || 'unknown',
          cached: headers.get('X-Cache-Status') === 'HIT',
        };

        return {
          ...data,
          pap_metadata: papMetadata,
        };
      } catch (error) {
        lastError = error as Error;
        console.warn(
          `[ModelRouter] Attempt ${attempt + 1}/${this.retries + 1} failed for ${request.model}:`,
          error instanceof Error ? error.message : error
        );

        // Don't retry on authentication errors - token may be revoked
        if (error instanceof AuthenticationError) {
          console.error('[ModelRouter] Authentication failed - token may be revoked');
          throw error;
        }

        if (attempt < this.retries) {
          await this.delay(this.retryDelay * (attempt + 1)); // Exponential backoff
        }
      }
    }

    throw lastError || new Error('Unknown error during chat completion');
  }

  /**
   * Get list of available models from the Model Router
   */
  async listModels(): Promise<ModelInfo[]> {
    const { data } = await this.makeRequest<{ data: Array<{ id: string; owned_by: string }> }>(
      '/v1/models',
      null,
      uuidv4(),
      'GET'
    );

    // Map to ModelInfo format
    return data.data.map(m => ({
      id: m.id,
      name: m.id,
      provider: m.owned_by,
      capabilities: ['chat'],
      context_length: 4096, // Default, actual value varies by model
      pricing: { input_per_1k: 0, output_per_1k: 0 },
    }));
  }

  /**
   * Check if a specific model is available on the Model Router
   */
  async isModelAvailable(modelId: string): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.some(m => m.id === modelId);
    } catch {
      return false;
    }
  }

  /**
   * Make an HTTP request to the Model Router
   *
   * AUTHENTICATION:
   * Uses Bearer token authentication with JWT issued by Station.
   * Token contains: sub (agent ID), name (agent name), exp (expiration)
   */
  private async makeRequest<T = ChatCompletionResponse>(
    endpoint: string,
    body: unknown | null,
    requestId: string,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<{ data: T; headers: Headers }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        // JWT authentication - token issued by Station
        'Authorization': `Bearer ${this.token}`,
        // PAP headers for tracking and observability
        'X-PAP-Agent-Id': this.agentId,
        'X-PAP-Request-Id': requestId,
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `HTTP ${response.status}`;

        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {
          errorMessage = errorBody || errorMessage;
        }

        // Handle specific error codes
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw new RateLimitError(errorMessage, retryAfter ? parseInt(retryAfter) : undefined);
        }

        if (response.status === 402) {
          throw new BudgetExceededError(errorMessage);
        }

        if (response.status === 401) {
          // Token may be revoked - this is a critical error
          throw new AuthenticationError(errorMessage);
        }

        throw new ModelRouterError(errorMessage, response.status);
      }

      const data = await response.json() as T;
      return { data, headers: response.headers };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

export class ModelRouterError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'ModelRouterError';
  }
}

export class RateLimitError extends ModelRouterError {
  constructor(
    message: string,
    public retryAfterSeconds?: number
  ) {
    super(message, 429);
    this.name = 'RateLimitError';
  }
}

export class BudgetExceededError extends ModelRouterError {
  constructor(message: string) {
    super(message, 402);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Authentication error - token may be invalid or revoked
 *
 * IMPORTANT: If you receive this error, the agent's token may have been
 * revoked from the Station admin UI. Check with your administrator.
 */
export class AuthenticationError extends ModelRouterError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let modelRouterInstance: ModelRouterClient | null = null;

/**
 * Initialize the Model Router client
 *
 * Call this once at agent startup with configuration from environment variables.
 *
 * @example
 * // In your agent's main.ts or index.ts:
 * initializeModelRouter({
 *   baseUrl: process.env.MODEL_ROUTER_URL || '',
 *   agentId: process.env.PAP_AGENT_ID || '',
 *   token: process.env.MODEL_ROUTER_TOKEN || '',
 * });
 */
export function initializeModelRouter(config: ModelRouterConfig): ModelRouterClient {
  modelRouterInstance = new ModelRouterClient(config);
  return modelRouterInstance;
}

/**
 * Get the initialized Model Router client
 *
 * @returns The Model Router client instance, or null if not initialized
 *
 * @example
 * const router = getModelRouter();
 * if (router) {
 *   const response = await router.chat({ model: 'gpt-4o', messages: [...] });
 * }
 */
export function getModelRouter(): ModelRouterClient | null {
  return modelRouterInstance;
}
