/**
 * PAP-RFC-001 Compliant Metrics Collector
 *
 * CRITICAL: Metrics are SEPARATE from heartbeats (zombie prevention)
 *
 * This channel contains:
 * - cpu_percent: CPU usage percentage
 * - memory_mb: Memory usage in MB
 * - requests_handled: Total requests processed
 * - custom_metrics: Agent-specific metrics
 *
 * Metrics are sent independently of heartbeats (typically every 60 seconds).
 * This separation ensures large telemetry payloads cannot starve the control path.
 */

import * as os from 'os';

interface MetricsPayload {
  cpu_percent: number;
  memory_mb: number;
  requests_handled: number;
  custom_metrics: Record<string, number | string | boolean>;
}

interface MetricsConfig {
  stationUrl: string;
  agentId: string;
  apiKey?: string;
  intervalMs?: number; // Default: 60000 (60 seconds)
}

interface QueryMetrics {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  totalLatencyMs: number;
  consensusResults: {
    unanimous: number;
    split: number;
    no_consensus: number;
  };
  modelMetrics: Record<string, {
    calls: number;
    successes: number;
    failures: number;
    totalLatencyMs: number;
  }>;
}

export class MetricsCollector {
  private stationUrl: string;
  private agentId: string;
  private apiKey?: string;
  private intervalMs: number;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Request counter
  private requestCount = 0;

  // Query metrics
  private queryMetrics: QueryMetrics = {
    totalQueries: 0,
    successfulQueries: 0,
    failedQueries: 0,
    totalLatencyMs: 0,
    consensusResults: {
      unanimous: 0,
      split: 0,
      no_consensus: 0,
    },
    modelMetrics: {},
  };

  // CPU tracking
  private lastCpuInfo: os.CpuInfo[] | null = null;
  private lastCpuTime: number = 0;

  constructor(config: MetricsConfig) {
    this.stationUrl = config.stationUrl;
    this.agentId = config.agentId;
    this.apiKey = config.apiKey;
    this.intervalMs = config.intervalMs ?? 60000; // Default: 60 seconds
  }

  /**
   * Start collecting and emitting metrics
   */
  start(): void {
    if (this.isRunning) {
      console.warn('[Metrics] Already running');
      return;
    }

    this.isRunning = true;
    this.lastCpuInfo = os.cpus();
    this.lastCpuTime = Date.now();

    this.intervalId = setInterval(async () => {
      try {
        await this.emit();
      } catch (err) {
        console.error('[Metrics] Failed to emit:', err);
      }
    }, this.intervalMs);

    console.log(`[Metrics] Started (${this.intervalMs}ms interval)`);
  }

  /**
   * Stop collecting metrics
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[Metrics] Stopped');
  }

  /**
   * Increment request counter
   */
  incrementRequests(): void {
    this.requestCount++;
  }

  /**
   * Record a query result
   */
  recordQuery(params: {
    success: boolean;
    latencyMs: number;
    verdict?: 'unanimous' | 'split' | 'no_consensus';
    modelResults?: Array<{
      model: string;
      success: boolean;
      latencyMs: number;
    }>;
  }): void {
    this.queryMetrics.totalQueries++;

    if (params.success) {
      this.queryMetrics.successfulQueries++;
    } else {
      this.queryMetrics.failedQueries++;
    }

    this.queryMetrics.totalLatencyMs += params.latencyMs;

    if (params.verdict) {
      this.queryMetrics.consensusResults[params.verdict]++;
    }

    if (params.modelResults) {
      for (const result of params.modelResults) {
        if (!this.queryMetrics.modelMetrics[result.model]) {
          this.queryMetrics.modelMetrics[result.model] = {
            calls: 0,
            successes: 0,
            failures: 0,
            totalLatencyMs: 0,
          };
        }

        const modelMetric = this.queryMetrics.modelMetrics[result.model];
        modelMetric.calls++;
        modelMetric.totalLatencyMs += result.latencyMs;

        if (result.success) {
          modelMetric.successes++;
        } else {
          modelMetric.failures++;
        }
      }
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): QueryMetrics & { requestCount: number } {
    return {
      ...this.queryMetrics,
      requestCount: this.requestCount,
    };
  }

  /**
   * Calculate CPU usage percentage since last check
   */
  private getCpuPercent(): number {
    const currentCpuInfo = os.cpus();
    const currentTime = Date.now();

    if (!this.lastCpuInfo || currentTime - this.lastCpuTime < 1000) {
      // Not enough time has passed for accurate measurement
      return 0;
    }

    let totalIdle = 0;
    let totalTick = 0;

    for (let i = 0; i < currentCpuInfo.length; i++) {
      const current = currentCpuInfo[i];
      const last = this.lastCpuInfo[i];

      const currentTotal = Object.values(current.times).reduce((a, b) => a + b, 0);
      const lastTotal = Object.values(last.times).reduce((a, b) => a + b, 0);

      totalTick += currentTotal - lastTotal;
      totalIdle += current.times.idle - last.times.idle;
    }

    this.lastCpuInfo = currentCpuInfo;
    this.lastCpuTime = currentTime;

    if (totalTick === 0) return 0;

    const cpuPercent = ((totalTick - totalIdle) / totalTick) * 100;
    return Math.round(cpuPercent * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Get memory usage in MB
   */
  private getMemoryMb(): number {
    const memUsage = process.memoryUsage();
    return Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100;
  }

  /**
   * Calculate consensus rate
   */
  private getConsensusRate(): number {
    const total = this.queryMetrics.totalQueries;
    if (total === 0) return 0;

    const consensusQueries =
      this.queryMetrics.consensusResults.unanimous +
      this.queryMetrics.consensusResults.split;

    return Math.round((consensusQueries / total) * 100);
  }

  /**
   * Calculate average query latency
   */
  private getAvgQueryLatencyMs(): number {
    if (this.queryMetrics.totalQueries === 0) return 0;
    return Math.round(this.queryMetrics.totalLatencyMs / this.queryMetrics.totalQueries);
  }

  /**
   * Get model availability status
   */
  private getModelAvailability(): Record<string, { available: boolean; successRate: number }> {
    const result: Record<string, { available: boolean; successRate: number }> = {};

    for (const [model, metrics] of Object.entries(this.queryMetrics.modelMetrics)) {
      const successRate = metrics.calls > 0
        ? Math.round((metrics.successes / metrics.calls) * 100)
        : 100;

      result[model] = {
        available: metrics.calls === 0 || metrics.successes > 0,
        successRate,
      };
    }

    return result;
  }

  /**
   * Emit metrics to PAP Station
   *
   * This is SEPARATE from heartbeats and contains resource data.
   */
  private async emit(): Promise<void> {
    const payload: MetricsPayload = {
      cpu_percent: this.getCpuPercent(),
      memory_mb: this.getMemoryMb(),
      requests_handled: this.requestCount,
      custom_metrics: {
        // Compass-specific metrics
        total_queries: this.queryMetrics.totalQueries,
        successful_queries: this.queryMetrics.successfulQueries,
        failed_queries: this.queryMetrics.failedQueries,
        avg_query_latency_ms: this.getAvgQueryLatencyMs(),
        consensus_rate: this.getConsensusRate(),
        unanimous_verdicts: this.queryMetrics.consensusResults.unanimous,
        split_verdicts: this.queryMetrics.consensusResults.split,
        no_consensus_verdicts: this.queryMetrics.consensusResults.no_consensus,
        model_availability: JSON.stringify(this.getModelAvailability()),
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(
      `${this.stationUrl}/api/agents/${this.agentId}/metrics`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}

// Singleton instance for the agent
let metricsInstance: MetricsCollector | null = null;

export function initializeMetrics(config: MetricsConfig): MetricsCollector {
  if (metricsInstance) {
    metricsInstance.stop();
  }
  metricsInstance = new MetricsCollector(config);
  return metricsInstance;
}

export function getMetrics(): MetricsCollector | null {
  return metricsInstance;
}
