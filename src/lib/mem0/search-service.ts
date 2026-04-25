/**
 * Search service for memory across agents
 * Implements full-text search, relevance scoring, filtering, caching
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import pino from 'pino';
import { 
  vectorSearch, 
  VectorSearchResult,
  VectorSearchOptions,
  SearchTerm,
  SearchResult,
  SearchFilter,
  SearchHistoryItem,
  SearchSuggestion
} from './vector-search-integration';

// Logger instance
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Cache for search results (5 minute TTL)
const searchCache = new Map<string, {
  result: SearchResult[];
  timestamp: number;
}>();

// Search history (last 10 searches)
const searchHistory: SearchHistoryItem[] = [];

/**
 * Search parameters schema
 */
const SearchParamsSchema = z.object({
  query: z.string().min(1),
  agentId: z.string().optional(),
  dateRange: z.object({
    from: z.string().optional(),
    to: z.string().optional()
  }).optional(),
  type: z.string().optional(),
  filters: z.record(z.string(), z.any()).optional(),
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
});

/**
 * Search term processing options
 */
interface SearchTermProcessorOptions {
  fuzzyMatch: boolean;
  stemming: boolean;
  booleanOperators: boolean;
  phraseSearch: boolean;
  wildcards: boolean;
}

/**
 * Search result highlighting options
 */
interface HighlightOptions {
  highlightTag: string;
  maxSnippetLength: number;
}

/**
 * Main search function for memory data across agents
 * @param params Search parameters
 * @returns Search results with relevance scores
 */
export async function searchMemory(params: any): Promise<SearchResult[]> {
  try {
    // Validate parameters
    const validationResult = SearchParamsSchema.safeParse(params);
    if (!validationResult.success) {
      throw new Error(`Invalid search parameters: ${JSON.stringify(validationResult.error.issues)}`);
    }
    
    const { query, agentId, dateRange, type, filters, limit, offset } = validationResult.data;
    
    // Process query terms
    const searchTerms = processQueryTerms(query);
    
    // Create cache key
    const cacheKey = generateCacheKey(query, agentId, dateRange, type, filters, limit, offset);
    
    // Try to get from cache first
    const cachedResult = searchCache.get(cacheKey);
    if (cachedResult && Date.now() - cachedResult.timestamp < 300000) { // 5 minutes
      logger.info('Returning cached search results', { cacheKey });
      return cachedResult.result;
    }

    // Prepare search filters
    const searchFilters: SearchFilter = {};
    if (agentId) searchFilters.agentId = agentId;
    if (type) searchFilters.type = type;
    if (dateRange) {
      searchFilters.dateFrom = dateRange.from;
      searchFilters.dateTo = dateRange.to;
    }
    if (filters) {
      Object.assign(searchFilters, filters);
    }

    // Perform vector search across memory
    const vectorOptions: VectorSearchOptions = {
      query: query,
      filters: searchFilters,
      limit: limit,
      offset: offset,
      searchTerms: searchTerms,
    };

    const vectorSearchResults = await vectorSearch(vectorOptions);

    // Apply relevance scoring and ranking
    const scoredResults = applyRelevanceScoring(vectorSearchResults, query, searchTerms);

    // Store in cache
    searchCache.set(cacheKey, {
      result: scoredResults,
      timestamp: Date.now()
    });

    // Update search history
    addToSearchHistory({
      query,
      timestamp: new Date().toISOString(),
      agentId,
      type,
      filters
    });

    return scoredResults;

  } catch (error) {
    logger.error('Memory search failed', { error: error instanceof Error ? error.message : String(error) });
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Process query terms for advanced search features
 */
function processQueryTerms(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  
  // Split query into tokens (handle quoted phrases)
  const tokens = query.match(/"[^"]*"|\S+/g) || [query];
  
  for (const token of tokens) {
    const term: SearchTerm = {
      text: token.replace(/"/g, ''), // Remove quotes
      isPhrase: token.startsWith('"'),
      isBooleanOp: ['AND', 'OR', 'NOT'].includes(token.toUpperCase()),
      isWildcard: token.includes('*')
    };
    
    terms.push(term);
  }
  
  return terms;
}

/**
 * Apply relevance scoring to search results
 */
function applyRelevanceScoring(
  results: VectorSearchResult[], 
  query: string, 
  searchTerms: SearchTerm[]
): SearchResult[] {
  return results.map(result => {
    // Calculate relevance score
    let score = 0;
    
    // Exact match boost
    if (result.content?.toLowerCase() === query.toLowerCase()) {
      score += 10;
    }
    
    // Partial match boost (fuzzy or partial)
    if (result.content?.toLowerCase().includes(query.toLowerCase())) {
      score += 5;
    }
    
    // Term frequency boost
    const termsInContent = searchTerms.filter(term => 
      term.text && result.content?.toLowerCase().includes(term.text.toLowerCase())
    ).length;
    score += termsInContent * 2;
    
    // Field matching boosts
    if (result.metadata?.agentId) score += 1;
    if (result.metadata?.type) score += 1;
    
    return {
      ...result,
      score: Math.max(0, score),
    };
  })
  .sort((a, b) => b.score - a.score); // Sort by highest score first
}

/**
 * Generate cache key for search results
 */
function generateCacheKey(
  query: string,
  agentId?: string,
  dateRange?: { from?: string; to?: string },
  type?: string,
  filters?: Record<string, any>,
  limit?: number,
  offset?: number
): string {
  const keyString = `${query}|${agentId}|${JSON.stringify(dateRange)}|${type}|${JSON.stringify(filters)}|${limit}|${offset}`;
  return createHash('md5').update(keyString).digest('hex');
}

/**
 * Add search to history
 */
function addToSearchHistory(item: SearchHistoryItem): void {
  searchHistory.unshift(item);
  if (searchHistory.length > 10) {
    searchHistory.pop();
  }
}

/**
 * Get recent search history
 */
export function getSearchHistory(): SearchHistoryItem[] {
  return [...searchHistory];
}

/**
 * Get search suggestions based on partial query
 */
export async function getSearchSuggestions(query: string): Promise<SearchSuggestion[]> {
  // In a real implementation, this would query a suggestions database or use NLP
  // For now, we'll return placeholder suggestions
  return [
    { suggestion: `${query} memory`, count: 100 },
    { suggestion: `${query} agent`, count: 50 },
    { suggestion: `${query} data`, count: 30 }
  ];
}

/**
 * Highlight matching terms in text
 */
export function highlightMatches(text: string, query: string, options?: HighlightOptions): string {
  if (!text || !query) return text;
  
  const opts = {
    highlightTag: '<mark>',
    maxSnippetLength: 200,
    ...options
  };
  
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  
  // Replace matches with highlighted version
  const highlighted = text.replace(regex, `${opts.highlightTag}$1${opts.highlightTag}`);
  
  // Truncate if too long
  if (highlighted.length > opts.maxSnippetLength) {
    return `${highlighted.substring(0, opts.maxSnippetLength - 3)}...`;
  }
  
  return highlighted;
}