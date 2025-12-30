/**
 * Circuit Breaker Unit Tests
 *
 * Tests the circuit breaker pattern implementation with focus on:
 * - Race condition fix in half-open state
 * - State transitions (CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN)
 * - Statistics tracking
 */

import { CircuitBreaker, CircuitState } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 1000, // 1 second for faster tests
    });
  });

  describe('Initial State', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.isAvailable()).toBe(true);
    });

    it('should allow requests in CLOSED state', () => {
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('CLOSED → OPEN Transition', () => {
    it('should transition to OPEN after threshold failures', () => {
      // Record 3 failures (threshold)
      breaker.canExecute();
      breaker.recordFailure();

      breaker.canExecute();
      breaker.recordFailure();

      breaker.canExecute();
      breaker.recordFailure();

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.isAvailable()).toBe(false);
    });

    it('should block requests when OPEN', () => {
      // Trigger OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }

      expect(breaker.canExecute()).toBe(false);
      expect(breaker.canExecute()).toBe(false);
    });

    it('should reset failure count on success while CLOSED', () => {
      // Record 2 failures (below threshold)
      breaker.canExecute();
      breaker.recordFailure();

      breaker.canExecute();
      breaker.recordFailure();

      // Record success - should reset counter
      breaker.canExecute();
      breaker.recordSuccess();

      // Should still be CLOSED after 2 more failures
      breaker.canExecute();
      breaker.recordFailure();

      breaker.canExecute();
      breaker.recordFailure();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('OPEN → HALF_OPEN Transition', () => {
    beforeEach(() => {
      // Force OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }
    });

    it('should stay OPEN during timeout period', () => {
      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.canExecute()).toBe(false);
    });

    it('should transition to HALF_OPEN after timeout', async () => {
      // Wait for timeout (1 second)
      await new Promise(resolve => setTimeout(resolve, 1100));

      const canExecute = breaker.canExecute();
      expect(canExecute).toBe(true);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should calculate remaining timeout correctly', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.OPEN);
      expect(stats.lastFailureTime).not.toBeNull();
    });
  });

  describe('HALF_OPEN State - Race Condition Fix', () => {
    beforeEach(async () => {
      // Force HALF_OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
      breaker.canExecute(); // Transition to HALF_OPEN
    });

    it('should only allow ONE request in HALF_OPEN state', () => {
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // First request already allowed in beforeEach
      // Subsequent requests should be rejected
      const secondRequest = breaker.canExecute();
      const thirdRequest = breaker.canExecute();

      expect(secondRequest).toBe(false);
      expect(thirdRequest).toBe(false);
    });

    it('should reject concurrent requests in HALF_OPEN', () => {
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Simulate rapid concurrent calls
      const results = [
        breaker.canExecute(),
        breaker.canExecute(),
        breaker.canExecute(),
        breaker.canExecute(),
      ];

      // All should be false (first request already in flight from beforeEach)
      expect(results.every(r => r === false)).toBe(true);
    });

    it('should clear flag on success', () => {
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // First request in flight, record success
      breaker.recordSuccess();

      // Should allow next request now
      expect(breaker.canExecute()).toBe(true);
    });

    it('should clear flag on failure', () => {
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // First request in flight, record failure
      breaker.recordFailure();

      // Should be OPEN again, but flag cleared
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('HALF_OPEN → CLOSED Transition', () => {
    beforeEach(async () => {
      // Force HALF_OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
      breaker.canExecute(); // Transition to HALF_OPEN
    });

    it('should transition to CLOSED after success threshold', () => {
      // Need 2 successes (successThreshold = 2)
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.canExecute(); // Allow next request
      breaker.recordSuccess();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow all requests after transitioning to CLOSED', () => {
      // Transition to CLOSED
      breaker.recordSuccess();
      breaker.canExecute();
      breaker.recordSuccess();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('HALF_OPEN → OPEN Transition', () => {
    beforeEach(async () => {
      // Force HALF_OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
      breaker.canExecute(); // Transition to HALF_OPEN
    });

    it('should transition back to OPEN on failure', () => {
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should block requests after returning to OPEN', () => {
      breaker.recordFailure();

      expect(breaker.canExecute()).toBe(false);
      expect(breaker.canExecute()).toBe(false);
    });

    it('should reset failure counter when reopening', () => {
      breaker.recordFailure();

      const stats = breaker.getStats();
      expect(stats.failures).toBe(0); // Counter reset
      expect(stats.state).toBe(CircuitState.OPEN);
    });
  });

  describe('Statistics', () => {
    it('should track total requests', () => {
      breaker.canExecute();
      breaker.canExecute();
      breaker.canExecute();

      const stats = breaker.getStats();
      expect(stats.totalRequests).toBe(3);
    });

    it('should track total successes', () => {
      breaker.canExecute();
      breaker.recordSuccess();

      breaker.canExecute();
      breaker.recordSuccess();

      const stats = breaker.getStats();
      expect(stats.totalSuccesses).toBe(2);
    });

    it('should track total failures', () => {
      breaker.canExecute();
      breaker.recordFailure();

      breaker.canExecute();
      breaker.recordFailure();

      const stats = breaker.getStats();
      expect(stats.totalFailures).toBe(2);
    });

    it('should track current failures', () => {
      breaker.canExecute();
      breaker.recordFailure();

      breaker.canExecute();
      breaker.recordFailure();

      const stats = breaker.getStats();
      expect(stats.failures).toBe(2);
    });

    it('should track last failure time', () => {
      const before = Date.now();

      breaker.canExecute();
      breaker.recordFailure();

      const stats = breaker.getStats();
      expect(stats.lastFailureTime).toBeGreaterThanOrEqual(before);
      expect(stats.lastFailureTime).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('Manual Reset', () => {
    it('should reset to CLOSED state', () => {
      // Force OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      breaker.reset();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.canExecute()).toBe(true);
    });

    it('should reset all counters', () => {
      // Generate some activity
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }

      breaker.reset();

      const stats = breaker.getStats();
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.lastFailureTime).toBeNull();
    });
  });

  describe('isAvailable() Method', () => {
    it('should return true when CLOSED', () => {
      expect(breaker.isAvailable()).toBe(true);
    });

    it('should return false when OPEN before timeout', () => {
      // Force OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.isAvailable()).toBe(false);
    });

    it('should return true when OPEN after timeout', async () => {
      // Force OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.isAvailable()).toBe(false);

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(breaker.isAvailable()).toBe(true);
    });

    it('should return true when HALF_OPEN', async () => {
      // Force HALF_OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }

      await new Promise(resolve => setTimeout(resolve, 1100));
      breaker.canExecute(); // Transition to HALF_OPEN

      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
      expect(breaker.isAvailable()).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid state transitions', async () => {
      // CLOSED → OPEN
      for (let i = 0; i < 3; i++) {
        breaker.canExecute();
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // OPEN → HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));
      breaker.canExecute();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // HALF_OPEN → OPEN
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // OPEN → HALF_OPEN → CLOSED
      await new Promise(resolve => setTimeout(resolve, 1100));
      breaker.canExecute();
      breaker.recordSuccess();
      breaker.canExecute();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should handle success without prior canExecute call', () => {
      // Edge case: recordSuccess without canExecute
      expect(() => breaker.recordSuccess()).not.toThrow();

      const stats = breaker.getStats();
      expect(stats.totalSuccesses).toBe(1);
    });

    it('should handle failure without prior canExecute call', () => {
      // Edge case: recordFailure without canExecute
      expect(() => breaker.recordFailure()).not.toThrow();

      const stats = breaker.getStats();
      expect(stats.totalFailures).toBe(1);
    });
  });
});
