/**
 * Circuit Breaker Pattern Implementation
 *
 * State Machine: Closed → Open (after threshold failures) → Half-Open (after timeout) → Closed/Open
 *
 * - Closed: Normal operation, all requests go through
 * - Open: Too many failures, requests are blocked for timeout period
 * - Half-Open: After timeout, allow one request to test if service recovered
 */

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

export interface CircuitBreakerConfig {
  failureThreshold?: number; // Number of failures before opening circuit
  successThreshold?: number; // Number of successes in half-open before closing
  timeout?: number; // Time in ms to wait before attempting half-open
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number | null = null;
  private halfOpenRequestInFlight: boolean = false; // Prevent race condition in half-open state
  private totalRequests: number = 0;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold || 5;
    this.successThreshold = config.successThreshold || 2;
    this.timeout = config.timeout || 30000; // 30 seconds default
  }

  /**
   * Check if request should be allowed through
   */
  canExecute(): boolean {
    this.totalRequests++;

    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      // Check if timeout has elapsed
      if (this.lastFailureTime && Date.now() - this.lastFailureTime >= this.timeout) {
        console.info('Circuit breaker transitioning to HALF_OPEN', {
          lastFailureTime: new Date(this.lastFailureTime).toISOString(),
          timeoutMs: this.timeout,
        });
        this.state = CircuitState.HALF_OPEN;
        this.successes = 0;
        this.halfOpenRequestInFlight = false; // Reset flag on transition
      } else {
        console.debug('Circuit breaker OPEN, rejecting request', {
          lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
          timeoutMs: this.timeout,
          remainingMs: this.lastFailureTime ? this.timeout - (Date.now() - this.lastFailureTime) : 0,
        });
        return false;
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      // Only allow ONE request in half-open state (prevents race condition)
      if (this.halfOpenRequestInFlight) {
        console.debug('Circuit breaker HALF_OPEN, test request in flight, rejecting');
        return false;
      }
      console.debug('Circuit breaker HALF_OPEN, allowing test request');
      this.halfOpenRequestInFlight = true;
      return true;
    }

    return false;
  }

  /**
   * Record successful request
   */
  recordSuccess(): void {
    this.totalSuccesses++;
    this.failures = 0;
    this.halfOpenRequestInFlight = false; // Clear flag on success

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        console.info('Circuit breaker transitioning to CLOSED', {
          successes: this.successes,
          successThreshold: this.successThreshold,
        });
        this.state = CircuitState.CLOSED;
        this.successes = 0;
      }
    }
  }

  /**
   * Record failed request
   */
  recordFailure(): void {
    this.totalFailures++;
    this.failures++;
    this.lastFailureTime = Date.now();
    this.halfOpenRequestInFlight = false; // Clear flag on failure

    if (this.state === CircuitState.HALF_OPEN) {
      // Single failure in half-open returns to open
      console.warn('Circuit breaker transitioning from HALF_OPEN to OPEN', {
        failures: this.failures,
      });
      this.state = CircuitState.OPEN;
      this.successes = 0;
      this.failures = 0; // Reset failure counter when reopening circuit
      return;
    }

    if (this.state === CircuitState.CLOSED && this.failures >= this.failureThreshold) {
      console.warn('Circuit breaker transitioning from CLOSED to OPEN', {
        failures: this.failures,
        failureThreshold: this.failureThreshold,
      });
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit is available (not open)
   */
  isAvailable(): boolean {
    if (this.state === CircuitState.OPEN) {
      // Check if we can transition to half-open
      if (this.lastFailureTime && Date.now() - this.lastFailureTime >= this.timeout) {
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    console.info('Circuit breaker manually reset');
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }
}
