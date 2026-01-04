/**
 * PAP-RFC-001 Compliant Heartbeat Emitter
 *
 * CRITICAL: Heartbeat contains ONLY liveness data
 * - mode: EMERGENCY | IDLE | SLEEP
 * - uptime_seconds: number
 *
 * NEVER include CPU, memory, or any resource data in heartbeats.
 * Resource data goes to the separate metrics channel.
 *
 * This separation is PAP's "zombie prevention superpower" - it prevents
 * large telemetry payloads from starving the control path.
 *
 * ARCHITECTURE: Local Collector with Fallback
 * - Primary: Send heartbeats to local PAP Heartbeat Collector (no auth, internal network)
 * - Fallback: Direct to central Station (requires auth) if collector unavailable
 */

export type HeartbeatMode = 'EMERGENCY' | 'IDLE' | 'SLEEP';

interface HeartbeatPayload {
  mode: HeartbeatMode;
  uptime_seconds: number;
  agent_name?: string;
}

interface HeartbeatConfig {
  stationUrl: string;
  agentId: string;
  agentName?: string;
  apiKey?: string;
  /** Local collector URL (e.g., http://pap-collector.agents.svc:8080) */
  collectorUrl?: string;
}

// PAP-RFC-001 §8.1 - Heartbeat intervals
const HEARTBEAT_INTERVALS: Record<HeartbeatMode, number> = {
  EMERGENCY: 5000,   // 5 seconds - critical issues
  IDLE: 30000,       // 30 seconds - normal operation
  SLEEP: 900000,     // 15 minutes - low activity
};

export class HeartbeatEmitter {
  private mode: HeartbeatMode = 'IDLE';
  private startTime: number;
  private stationUrl: string;
  private agentId: string;
  private agentName: string;
  private apiKey?: string;
  private collectorUrl?: string;
  private collectorHealthy = true;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private consecutiveFailures = 0;
  private maxConsecutiveFailures = 3;
  private lastCollectorCheck = 0;
  private collectorCheckInterval = 60000; // Re-check collector health every 60s

  constructor(config: HeartbeatConfig) {
    this.stationUrl = config.stationUrl;
    this.agentId = config.agentId;
    this.agentName = config.agentName || config.agentId;
    this.apiKey = config.apiKey;
    this.collectorUrl = config.collectorUrl;
    this.startTime = Date.now();

    if (this.collectorUrl) {
      console.log(`[Heartbeat] Collector configured: ${this.collectorUrl}`);
    } else {
      console.log(`[Heartbeat] No collector configured, using direct station mode`);
    }
  }

  /**
   * Start emitting heartbeats at the current mode's interval
   */
  start(): void {
    if (this.isRunning) {
      console.warn('[Heartbeat] Already running');
      return;
    }

    this.isRunning = true;
    this.scheduleNextHeartbeat();
    console.log(`[Heartbeat] Started in ${this.mode} mode (${HEARTBEAT_INTERVALS[this.mode]}ms interval)`);

    // Emit first heartbeat immediately
    this.emit().catch(err => {
      console.error('[Heartbeat] Initial heartbeat failed:', err);
    });
  }

  /**
   * Stop emitting heartbeats
   */
  stop(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[Heartbeat] Stopped');
  }

  /**
   * Change heartbeat mode and adjust interval accordingly
   */
  setMode(mode: HeartbeatMode): void {
    if (this.mode === mode) return;

    const oldMode = this.mode;
    this.mode = mode;

    // Reschedule with new interval if running
    if (this.isRunning && this.intervalId) {
      clearTimeout(this.intervalId);
      this.scheduleNextHeartbeat();
    }

    console.log(`[Heartbeat] Mode changed: ${oldMode} → ${mode} (${HEARTBEAT_INTERVALS[mode]}ms interval)`);
  }

  /**
   * Get current heartbeat mode
   */
  getMode(): HeartbeatMode {
    return this.mode;
  }

  /**
   * Get uptime in seconds
   */
  getUptimeSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Check if heartbeat emitter is healthy (no consecutive failures)
   */
  isHealthy(): boolean {
    return this.consecutiveFailures < this.maxConsecutiveFailures;
  }

  private scheduleNextHeartbeat(): void {
    this.intervalId = setTimeout(async () => {
      try {
        await this.emit();
      } catch (err) {
        console.error('[Heartbeat] Failed to emit:', err);
      }

      if (this.isRunning) {
        this.scheduleNextHeartbeat();
      }
    }, HEARTBEAT_INTERVALS[this.mode]);
  }

  /**
   * Emit a heartbeat to the PAP Station
   *
   * CRITICAL: Only sends liveness data (mode + uptime)
   * NO CPU, memory, or resource data here - that's in metrics!
   *
   * Strategy:
   * 1. If collector URL configured and collector is healthy, send to collector (no auth)
   * 2. If collector fails or not configured, send directly to station (with auth)
   */
  private async emit(): Promise<void> {
    const payload: HeartbeatPayload = {
      mode: this.mode,
      uptime_seconds: this.getUptimeSeconds(),
      agent_name: this.agentName,
      // CRITICAL: No CPU, memory, or resource data here!
    };

    // Try local collector first (if configured and healthy)
    if (this.collectorUrl && this.shouldUseCollector()) {
      try {
        await this.sendToCollector(payload);
        this.consecutiveFailures = 0;
        return; // Success - no need for fallback
      } catch (error) {
        console.warn(`[Heartbeat] Collector failed, falling back to station:`, error);
        this.collectorHealthy = false;
        this.lastCollectorCheck = Date.now();
        // Fall through to station
      }
    }

    // Fallback: Direct to station (requires auth)
    await this.sendToStation(payload);
  }

  /**
   * Check if we should attempt using the collector
   */
  private shouldUseCollector(): boolean {
    if (!this.collectorUrl) return false;

    // If collector was unhealthy, periodically re-check
    if (!this.collectorHealthy) {
      const timeSinceCheck = Date.now() - this.lastCollectorCheck;
      if (timeSinceCheck > this.collectorCheckInterval) {
        console.log('[Heartbeat] Re-checking collector health...');
        this.collectorHealthy = true; // Optimistically retry
      }
    }

    return this.collectorHealthy;
  }

  /**
   * Send heartbeat to local collector (no auth required - internal network)
   */
  private async sendToCollector(payload: HeartbeatPayload): Promise<void> {
    const response = await fetch(
      `${this.collectorUrl}/heartbeat/${this.agentId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000), // 5s timeout for collector
      }
    );

    if (!response.ok) {
      throw new Error(`Collector HTTP ${response.status}: ${response.statusText}`);
    }

    // Mark collector as healthy on success
    this.collectorHealthy = true;
  }

  /**
   * Send heartbeat directly to PAP Station (requires auth)
   */
  private async sendToStation(payload: HeartbeatPayload): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(
        `${this.stationUrl}/api/agents/${this.agentId}/heartbeat`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        throw new Error(`Station HTTP ${response.status}: ${response.statusText}`);
      }

      // Reset failure counter on success
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;

      // Switch to EMERGENCY mode if too many failures
      if (this.consecutiveFailures >= this.maxConsecutiveFailures && this.mode !== 'EMERGENCY') {
        console.warn(`[Heartbeat] ${this.consecutiveFailures} consecutive failures, switching to EMERGENCY mode`);
        this.setMode('EMERGENCY');
      }

      throw error;
    }
  }
}

// Singleton instance for the agent
let heartbeatInstance: HeartbeatEmitter | null = null;

export function initializeHeartbeat(config: HeartbeatConfig): HeartbeatEmitter {
  if (heartbeatInstance) {
    heartbeatInstance.stop();
  }
  heartbeatInstance = new HeartbeatEmitter(config);
  return heartbeatInstance;
}

export function getHeartbeat(): HeartbeatEmitter | null {
  return heartbeatInstance;
}
