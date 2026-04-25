/**
 * Types for search events emitted for observability purposes
 */

/**
 * Base event interface that follows the unified event tracking schema
 */
export interface SearchEventBase {
  /**
   * Partition Key: SERVICE#{serviceName}#TENANT#{tenant}#DELIVERY#{eventId} or METRICS
   */
  pk: string;
  
  /**
   * Sort Key: ISO 8601 Timestamp
   */
  sk: string;
  
  /**
   * Identifier of the service generating the event (e.g., klaviyo, shopify, smartgo)
   */
  serviceName: string;
  
  /**
   * Tenant identifier
   */
  tenant: string;
  
  /**
   * Unique identifier for the specific event instance
   */
  eventId: string;
  
  /**
   * Category of event (e.g., booking.created, product.sync)
   */
  eventType: string;
  
  /**
   * Type of resource affected (e.g., booking, product, user)
   */
  resourceType: string;
  
  /**
   * Current status of the event delivery/processing
   */
  status: 'delivered' | 'failed' | 'retrying' | 'circuit_open';
  
  /**
   * Number of attempts made to process this event
   */
  attemptCount: number;
  
  /**
   * ISO 8601 timestamp of when the record was created
   */
  timestamp: string;
  
  /**
   * Latency in milliseconds for successful processing
   */
  deliveryTimeMs?: number;
  
  /**
   * Processing start time
   */
  processingStartTime?: string;
  
  /**
   * Processing end time
   */
  processingEndTime?: string;
  
  /**
   * Classification of the error if status is failed
   */
  errorType?: string;
  
  /**
   * Truncated error message details
   */
  errorMessage?: string;
  
  /**
   * Optional truncated stack trace
   */
  errorStack?: string;
  
  /**
   * Circuit breaker state
   */
  circuitBreakerState?: 'OPEN' | 'CLOSED' | 'HALF_OPEN';
  
  /**
   * Additional context-specific data
   */
  metadata?: Record<string, any>;
  
  /**
   * Unix timestamp for record expiration (typically 30 days)
   */
  ttl: number;
  
  /**
   * GSI Partition Key: SERVICE#{serviceName}#TENANT#{tenant}#STATUS#{status}
   */
  gsi1pk: string;
  
  /**
   * GSI Sort Key: {timestamp}
   */
  gsi1sk: string;
}

/**
 * Search query event type
 */
export interface SearchQueryEvent extends SearchEventBase {
  eventType: 'search.query';
  resourceType: 'search';
  metadata: {
    /**
     * The search query text
     */
    query: string;
    
    /**
     * The tenant ID
     */
    tenantId: string;
    
    /**
     * The agent ID (if applicable)
     */
    agentId?: string;
    
    /**
     * The type of search (if applicable)
     */
    type?: string;
    
    /**
     * The limit of results requested
     */
    limit?: number;
    
    /**
     * The offset for pagination
     */
    offset?: number;
    
    /**
     * The date range for search (from)
     */
    dateFrom?: string;
    
    /**
     * The date range for search (to)
     */
    dateTo?: string;
    
    /**
     * The number of results returned
     */
    resultCount?: number;
    
    /**
     * The latency in milliseconds for the search operation
     */
    latencyMs?: number;
    
    /**
     * Whether the search was successful
     */
    success: boolean;
  };
}

/**
 * Search suggestion event type
 */
export interface SearchSuggestionEvent extends SearchEventBase {
  eventType: 'search.suggestion';
  resourceType: 'search';
  metadata: {
    /**
     * The search query text for which suggestions were generated
     */
    query: string;
    
    /**
     * The tenant ID
     */
    tenantId: string;
    
    /**
     * The number of suggestions returned
     */
    suggestionCount?: number;
    
    /**
     * The latency in milliseconds for generating suggestions
     */
    latencyMs?: number;
    
    /**
     * Whether the suggestion generation was successful
     */
    success: boolean;
  };
}

/**
 * Search history event type
 */
export interface SearchHistoryEvent extends SearchEventBase {
  eventType: 'search.history';
  resourceType: 'search';
  metadata: {
    /**
     * The tenant ID
     */
    tenantId: string;
    
    /**
     * The number of history items returned
     */
    historyCount?: number;
    
    /**
     * The latency in milliseconds for retrieving history
     */
    latencyMs?: number;
    
    /**
     * Whether the history retrieval was successful
     */
    success: boolean;
  };
}

/**
 * Union type for all search-related events
 */
export type SearchEvent = SearchQueryEvent | SearchSuggestionEvent | SearchHistoryEvent;

/**
 * Search event factory functions to help create properly structured events
 */
export class SearchEventFactory {
  static createBaseEvent(
    serviceName: string,
    tenant: string,
    eventType: string,
    resourceId: string,
    status: 'delivered' | 'failed' | 'retrying' | 'circuit_open',
    attemptCount: number = 1
  ): SearchEventBase {
    const now = new Date();
    const timestamp = now.toISOString();
    const ttl = Math.floor(now.getTime() / 1000) + (30 * 24 * 60 * 60); // 30 days from now
    
    return {
      pk: `SERVICE#${serviceName}#TENANT#${tenant}#DELIVERY#${resourceId}`,
      sk: timestamp,
      serviceName,
      tenant,
      eventId: resourceId,
      eventType,
      resourceType: 'search',
      status,
      attemptCount,
      timestamp,
      ttl,
      gsi1pk: `SERVICE#${serviceName}#TENANT#${tenant}#STATUS#${status}`,
      gsi1sk: timestamp
    };
  }
  
  static createSearchQueryEvent(
    serviceName: string,
    tenant: string,
    query: string,
    tenantId: string,
    agentId?: string,
    type?: string,
    limit?: number,
    offset?: number,
    dateFrom?: string,
    dateTo?: string,
    resultCount?: number,
    latencyMs?: number,
    success: boolean = true,
    resourceId?: string,
    status: 'delivered' | 'failed' | 'retrying' | 'circuit_open' = 'delivered',
    attemptCount: number = 1
  ): SearchQueryEvent {
    const eventId = resourceId || `search-query-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      ...this.createBaseEvent(serviceName, tenant, 'search.query', eventId, status, attemptCount),
      metadata: {
        query,
        tenantId,
        agentId,
        type,
        limit,
        offset,
        dateFrom,
        dateTo,
        resultCount,
        latencyMs,
        success
      }
    };
  }
  
  static createSearchSuggestionEvent(
    serviceName: string,
    tenant: string,
    query: string,
    tenantId: string,
    suggestionCount?: number,
    latencyMs?: number,
    success: boolean = true,
    resourceId?: string,
    status: 'delivered' | 'failed' | 'retrying' | 'circuit_open' = 'delivered',
    attemptCount: number = 1
  ): SearchSuggestionEvent {
    const eventId = resourceId || `search-suggestion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      ...this.createBaseEvent(serviceName, tenant, 'search.suggestion', eventId, status, attemptCount),
      metadata: {
        query,
        tenantId,
        suggestionCount,
        latencyMs,
        success
      }
    };
  }
  
  static createSearchHistoryEvent(
    serviceName: string,
    tenant: string,
    tenantId: string,
    historyCount?: number,
    latencyMs?: number,
    success: boolean = true,
    resourceId?: string,
    status: 'delivered' | 'failed' | 'retrying' | 'circuit_open' = 'delivered',
    attemptCount: number = 1
  ): SearchHistoryEvent {
    const eventId = resourceId || `search-history-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      ...this.createBaseEvent(serviceName, tenant, 'search.history', eventId, status, attemptCount),
      metadata: {
        tenantId,
        historyCount,
        latencyMs,
        success
      }
    };
  }
}