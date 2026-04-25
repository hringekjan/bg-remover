/** 
 * API handler for memory search endpoints
 * Handles search requests, autocomplete, and search history
 */

import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { 
  searchMemory, 
  getSearchHistory, 
  getSearchSuggestions,
  highlightMatches 
} from './search-service';
import { 
  extractAuthContext, 
  isAdmin, 
  isStaff, 
  isSuperAdmin 
} from '../../utils/auth';
import { httpResponse, errorResponse } from '../../utils/response';
import { withSearchRBAC } from '../../lib/middleware/search-rbac';
import pino from 'pino';
import { SearchEventFactory } from '../types/search-events';
import { emitSearchEvent } from '../../utils/search-event-emitter';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Search memory across all agents
 */
export const searchMemoryHandler = withSearchRBAC(async (event: any, authContext): Promise<APIGatewayProxyResultV2> => {
  const startTime = new Date();
  let eventId = '';
  
  try {
    logger.info('Search memory request received', {
      path: event.requestContext?.http?.path,
      method: event.requestContext?.http?.method,
      tenantId: authContext.tenantId
    });

    // Validate request method
    if (event.requestContext?.http?.method !== 'GET') {
      const errorEvent = SearchEventFactory.createSearchQueryEvent(
        'bg-remover',
        authContext.tenantId,
        '',
        authContext.tenantId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(405, 'Method not allowed');
    }

    // Parse query parameters
    const queryParams = new URLSearchParams(event.queryStringParameters ? 
      Object.entries(event.queryStringParameters).map(([k, v]) => [k, v || '']) : []);
    
    const query = queryParams.get('q') || '';
    const agentId = queryParams.get('agentId') || undefined;
    const type = queryParams.get('type') || undefined;
    const limit = parseInt(queryParams.get('limit') || '10', 10);
    const offset = parseInt(queryParams.get('offset') || '0', 10);
    const dateFrom = queryParams.get('dateFrom') || undefined;
    const dateTo = queryParams.get('dateTo') || undefined;
    
    // Validate query
    if (!query.trim()) {
      const errorEvent = SearchEventFactory.createSearchQueryEvent(
        'bg-remover',
        authContext.tenantId,
        query,
        authContext.tenantId,
        agentId,
        type,
        limit,
        offset,
        dateFrom,
        dateTo,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(400, 'Query parameter is required');
    }

    // Validate numeric parameters
    if (isNaN(limit) || limit < 1 || limit > 100) {
      const errorEvent = SearchEventFactory.createSearchQueryEvent(
        'bg-remover',
        authContext.tenantId,
        query,
        authContext.tenantId,
        agentId,
        type,
        limit,
        offset,
        dateFrom,
        dateTo,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(400, 'Limit must be between 1 and 100');
    }
    
    if (isNaN(offset) || offset < 0) {
      const errorEvent = SearchEventFactory.createSearchQueryEvent(
        'bg-remover',
        authContext.tenantId,
        query,
        authContext.tenantId,
        agentId,
        type,
        limit,
        offset,
        dateFrom,
        dateTo,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(400, 'Offset must be a non-negative integer');
    }

    // Prepare search parameters
    const searchParams = {
      query,
      agentId,
      type,
      limit,
      offset,
      dateRange: dateFrom || dateTo ? {
        from: dateFrom,
        to: dateTo
      } : undefined
    };

    // Perform search
    const results = await searchMemory(searchParams);
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();

    // Add highlighting to results
    const highlightedResults = results.map(result => ({
      ...result,
      content: highlightMatches(result.content || '', query)
    }));

    const successEvent = SearchEventFactory.createSearchQueryEvent(
      'bg-remover',
      authContext.tenantId,
      query,
      authContext.tenantId,
      agentId,
      type,
      limit,
      offset,
      dateFrom,
      dateTo,
      results.length,
      latencyMs,
      true
    );
    await emitSearchEvent(successEvent);

    return httpResponse(200, {
      results: highlightedResults,
      total: results.length,
      query,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();
    
    logger.error('Search memory handler error', {
      error: error instanceof Error ? error.message : String(error),
      tenantId: authContext.tenantId
    });

    const errorEvent = SearchEventFactory.createSearchQueryEvent(
      'bg-remover',
      authContext.tenantId,
      queryParams.get('q') || '',
      authContext.tenantId,
      queryParams.get('agentId') || undefined,
      queryParams.get('type') || undefined,
      parseInt(queryParams.get('limit') || '10', 10),
      parseInt(queryParams.get('offset') || '0', 10),
      queryParams.get('dateFrom') || undefined,
      queryParams.get('dateTo') || undefined,
      undefined,
      latencyMs,
      false
    );
    await emitSearchEvent(errorEvent);

    return errorResponse(500, 'Internal server error');
  }
});

/**
 * Get search suggestions
 */
export const getSearchSuggestionsHandler = withSearchRBAC(async (event: any, authContext): Promise<APIGatewayProxyResultV2> => {
  const startTime = new Date();
  
  try {
    logger.info('Get search suggestions request received', {
      path: event.requestContext?.http?.path,
      method: event.requestContext?.http?.method,
      tenantId: authContext.tenantId
    });

    // Validate request method
    if (event.requestContext?.http?.method !== 'GET') {
      const errorEvent = SearchEventFactory.createSearchSuggestionEvent(
        'bg-remover',
        authContext.tenantId,
        '',
        authContext.tenantId,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(405, 'Method not allowed');
    }

    // Parse query parameters
    const queryParams = new URLSearchParams(event.queryStringParameters ? 
      Object.entries(event.queryStringParameters).map(([k, v]) => [k, v || '']) : []);
    
    const query = queryParams.get('q') || '';

    // Validate query
    if (!query.trim()) {
      const errorEvent = SearchEventFactory.createSearchSuggestionEvent(
        'bg-remover',
        authContext.tenantId,
        query,
        authContext.tenantId,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(400, 'Query parameter is required');
    }

    // Get suggestions
    const suggestions = await getSearchSuggestions(query);
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();

    const successEvent = SearchEventFactory.createSearchSuggestionEvent(
      'bg-remover',
      authContext.tenantId,
      query,
      authContext.tenantId,
      suggestions.length,
      latencyMs,
      true
    );
    await emitSearchEvent(successEvent);

    return httpResponse(200, {
      suggestions,
      query,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();
    
    logger.error('Get search suggestions handler error', {
      error: error instanceof Error ? error.message : String(error),
      tenantId: authContext.tenantId
    });

    const errorEvent = SearchEventFactory.createSearchSuggestionEvent(
      'bg-remover',
      authContext.tenantId,
      queryParams.get('q') || '',
      authContext.tenantId,
      undefined,
      latencyMs,
      false
    );
    await emitSearchEvent(errorEvent);

    return errorResponse(500, 'Internal server error');
  }
});

/**
 * Get search history
 */
export const getSearchHistoryHandler = withSearchRBAC(async (event: any, authContext): Promise<APIGatewayProxyResultV2> => {
  const startTime = new Date();
  
  try {
    logger.info('Get search history request received', {
      path: event.requestContext?.http?.path,
      method: event.requestContext?.http?.method,
      tenantId: authContext.tenantId
    });

    // Validate request method
    if (event.requestContext?.http?.method !== 'GET') {
      const errorEvent = SearchEventFactory.createSearchHistoryEvent(
        'bg-remover',
        authContext.tenantId,
        authContext.tenantId,
        undefined,
        0,
        false
      );
      await emitSearchEvent(errorEvent);
      return errorResponse(405, 'Method not allowed');
    }

    // Get search history
    const history = getSearchHistory();
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();

    const successEvent = SearchEventFactory.createSearchHistoryEvent(
      'bg-remover',
      authContext.tenantId,
      authContext.tenantId,
      history.length,
      latencyMs,
      true
    );
    await emitSearchEvent(successEvent);

    return httpResponse(200, {
      history,
      count: history.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    const endTime = new Date();
    const latencyMs = endTime.getTime() - startTime.getTime();
    
    logger.error('Get search history handler error', {
      error: error instanceof Error ? error.message : String(error),
      tenantId: authContext.tenantId
    });

    const errorEvent = SearchEventFactory.createSearchHistoryEvent(
      'bg-remover',
      authContext.tenantId,
      authContext.tenantId,
      undefined,
      latencyMs,
      false
    );
    await emitSearchEvent(errorEvent);

    return errorResponse(500, 'Internal server error');
  }
});