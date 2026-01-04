/**
 * PAP Agent Lifecycle Manager
 *
 * Implements the PAP-RFC-001 normative state machine:
 *
 * NEW → PROVISIONED → ACTIVE ↔ DRAINING → TERMINATED
 *                        ↓ (error)
 *                      KILLED
 *
 * State transitions must follow normative paths.
 * Station holds exclusive kill authority.
 */

export type AgentState =
  | 'NEW'
  | 'PROVISIONED'
  | 'ACTIVE'
  | 'DRAINING'
  | 'TERMINATED'
  | 'KILLED';

interface StateTransition {
  from: AgentState;
  to: AgentState;
  timestamp: Date;
  reason?: string;
}

type StateChangeHandler = (oldState: AgentState, newState: AgentState, reason?: string) => void;

// Valid state transitions according to PAP-RFC-001
const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  NEW: ['PROVISIONED'],
  PROVISIONED: ['ACTIVE'],
  ACTIVE: ['DRAINING', 'KILLED'],
  DRAINING: ['TERMINATED', 'ACTIVE'], // Can return to ACTIVE if draining cancelled
  TERMINATED: [], // Terminal state
  KILLED: [], // Terminal state (error path)
};

export class LifecycleManager {
  private currentState: AgentState = 'NEW';
  private history: StateTransition[] = [];
  private changeHandlers: StateChangeHandler[] = [];
  private stationUrl: string;
  private agentId: string;
  private apiKey?: string;

  constructor(config: { stationUrl: string; agentId: string; apiKey?: string }) {
    this.stationUrl = config.stationUrl;
    this.agentId = config.agentId;
    this.apiKey = config.apiKey;
  }

  /**
   * Get current agent state
   */
  getState(): AgentState {
    return this.currentState;
  }

  /**
   * Get state transition history
   */
  getHistory(): StateTransition[] {
    return [...this.history];
  }

  /**
   * Check if a transition is valid
   */
  canTransitionTo(targetState: AgentState): boolean {
    return VALID_TRANSITIONS[this.currentState].includes(targetState);
  }

  /**
   * Attempt to transition to a new state
   */
  async transitionTo(targetState: AgentState, reason?: string): Promise<boolean> {
    if (!this.canTransitionTo(targetState)) {
      console.error(
        `[Lifecycle] Invalid transition: ${this.currentState} → ${targetState}. ` +
        `Valid transitions: ${VALID_TRANSITIONS[this.currentState].join(', ') || 'none'}`
      );
      return false;
    }

    const oldState = this.currentState;
    this.currentState = targetState;

    const transition: StateTransition = {
      from: oldState,
      to: targetState,
      timestamp: new Date(),
      reason,
    };
    this.history.push(transition);

    console.log(`[Lifecycle] State transition: ${oldState} → ${targetState}${reason ? ` (${reason})` : ''}`);

    // Notify handlers
    for (const handler of this.changeHandlers) {
      try {
        handler(oldState, targetState, reason);
      } catch (err) {
        console.error('[Lifecycle] Handler error:', err);
      }
    }

    // Report to Station
    await this.reportTransition(transition);

    return true;
  }

  /**
   * Register a state change handler
   */
  onStateChange(handler: StateChangeHandler): () => void {
    this.changeHandlers.push(handler);
    return () => {
      const index = this.changeHandlers.indexOf(handler);
      if (index >= 0) {
        this.changeHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Check if agent is in a terminal state
   */
  isTerminal(): boolean {
    return this.currentState === 'TERMINATED' || this.currentState === 'KILLED';
  }

  /**
   * Check if agent is operational (can handle requests)
   */
  isOperational(): boolean {
    return this.currentState === 'ACTIVE';
  }

  /**
   * Initialize lifecycle (typically called after agent container starts)
   */
  async initialize(): Promise<void> {
    // Agent starts in NEW state
    // Transition to PROVISIONED when container is ready
    await this.transitionTo('PROVISIONED', 'Container initialized');
  }

  /**
   * Activate the agent (transition to ACTIVE)
   */
  async activate(): Promise<boolean> {
    return this.transitionTo('ACTIVE', 'Agent ready to serve');
  }

  /**
   * Start draining the agent (prepare for shutdown)
   */
  async drain(reason?: string): Promise<boolean> {
    return this.transitionTo('DRAINING', reason || 'Graceful shutdown initiated');
  }

  /**
   * Terminate the agent (after draining)
   */
  async terminate(reason?: string): Promise<boolean> {
    return this.transitionTo('TERMINATED', reason || 'Agent terminated');
  }

  /**
   * Kill the agent (error path, skips draining)
   * Note: Only Station should call this directly
   */
  async kill(reason?: string): Promise<boolean> {
    // KILLED can only be reached from ACTIVE
    if (this.currentState !== 'ACTIVE') {
      console.warn(`[Lifecycle] Cannot kill from ${this.currentState}, only from ACTIVE`);
      return false;
    }
    return this.transitionTo('KILLED', reason || 'Agent killed');
  }

  /**
   * Report state transition to PAP Station
   */
  private async reportTransition(transition: StateTransition): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(
        `${this.stationUrl}/api/agents/${this.agentId}/lifecycle`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event_type: 'STATE_CHANGE',
            from_state: transition.from,
            to_state: transition.to,
            reason: transition.reason,
            timestamp: transition.timestamp.toISOString(),
          }),
        }
      );

      if (!response.ok) {
        console.warn(`[Lifecycle] Failed to report transition: HTTP ${response.status}`);
      }
    } catch (err) {
      console.error('[Lifecycle] Failed to report transition:', err);
    }
  }
}

// Singleton instance
let lifecycleInstance: LifecycleManager | null = null;

export function initializeLifecycle(config: {
  stationUrl: string;
  agentId: string;
  apiKey?: string;
}): LifecycleManager {
  lifecycleInstance = new LifecycleManager(config);
  return lifecycleInstance;
}

export function getLifecycle(): LifecycleManager | null {
  return lifecycleInstance;
}
