import { ContextScope } from '@carousellabs/context-scope';
import { SearchAdapter } from '../lib/middleware/context-scope';

/**
 * Interface representing historical search data
 */
interface HistoricalSearchData {
  id: string;
  query: string;
  results: Record<string, unknown>[];
  timestamp: number;
  userId: string;
  tenantId: string;
}

/**
 * Interface representing new search data
 */
interface NewSearchData {
  id: string;
  query: string;
  results: Record<string, unknown>[];
  timestamp: number;
  userId: string;
  tenantId: string;
  source: 'new' | 'historical';
}

/**
 * Service for converging historical and new search data
 */
export class SearchDataConvergenceService {
  private contextScope: ContextScope;

  constructor(contextScope: ContextScope) {
    this.contextScope = contextScope;
  }

  /**
   * Converge historical and new search data
   * @param historicalData - Array of historical search data
   * @param newData - Array of new search data
   * @returns Merged search data with deduplication
   */
  async convergeSearchData(
    historicalData: HistoricalSearchData[],
    newData: NewSearchData[]
  ): Promise<Record<string, unknown>[]> {
    try {
      // Combine both datasets
      const combinedData = [...historicalData, ...newData];
      
      // Deduplicate based on query and timestamp
      const uniqueData = this.deduplicateSearchData(combinedData);
      
      // Sort by timestamp descending (newest first)
      uniqueData.sort((a, b) => b.timestamp - a.timestamp);
      
      // Track metrics
      this.contextScope.setMetric('searchDataConvergenceSuccess', 1);
      this.contextScope.setMetric('searchDataItemsProcessed', uniqueData.length);
      
      return uniqueData;
    } catch (error) {
      this.contextScope.setMetric('searchDataConvergenceError', 1);
      console.error('Search data convergence error:', error);
      throw error;
    }
  }

  /**
   * Deduplicate search data based on query and timestamp
   */
  private deduplicateSearchData(data: (HistoricalSearchData | NewSearchData)[]): (HistoricalSearchData | NewSearchData)[] {
    const seenQueries = new Set<string>();
    const deduplicated: (HistoricalSearchData | NewSearchData)[] = [];

    // Process in reverse order so newer items take precedence
    for (let i = data.length - 1; i >= 0; i--) {
      const item = data[i];
      const queryKey = `${item.query}_${item.userId}_${item.tenantId}`;
      
      if (!seenQueries.has(queryKey)) {
        seenQueries.add(queryKey);
        deduplicated.unshift(item);
      }
    }

    return deduplicated;
  }

  /**
   * Retrieve historical search data from database or storage
   * This would connect to a historical data store (e.g., DynamoDB, S3, etc.)
   */
  async retrieveHistoricalSearchData(queryParams: Record<string, unknown>): Promise<HistoricalSearchData[]> {
    // Mock implementation - in reality, this would query a database or storage system
    console.log('Retrieving historical search data with params:', queryParams);
    
    // This is a simplified mock - in production this would be replaced with real data retrieval
    const mockHistoricalData: HistoricalSearchData[] = [
      {
        id: 'hist-1',
        query: 'laptop',
        results: [{ id: '1', title: 'MacBook Pro', type: 'product' }],
        timestamp: Date.now() - 1000 * 60 * 60 * 24, // 1 day ago
        userId: 'user-123',
        tenantId: 'tenant-abc'
      },
      {
        id: 'hist-2',
        query: 'phone',
        results: [{ id: '2', title: 'iPhone 14', type: 'product' }],
        timestamp: Date.now() - 1000 * 60 * 60 * 12, // 12 hours ago
        userId: 'user-123',
        tenantId: 'tenant-abc'
      }
    ];

    // Add metrics
    this.contextScope.setMetric('historicalSearchDataRetrieved', mockHistoricalData.length);
    
    return mockHistoricalData;
  }

  /**
   * Retrieve new search data 
   * This would connect to recent search tracking systems
   */
  async retrieveNewSearchData(queryParams: Record<string, unknown>): Promise<NewSearchData[]> {
    // Mock implementation - in reality, this would query recent search tracking systems
    console.log('Retrieving new search data with params:', queryParams);
    
    // This is a simplified mock - in production this would be replaced with real data retrieval
    const mockNewData: NewSearchData[] = [
      {
        id: 'new-1',
        query: 'laptop',
        results: [{ id: '3', title: 'Dell XPS', type: 'product' }],
        timestamp: Date.now(),
        userId: 'user-123',
        tenantId: 'tenant-abc',
        source: 'new'
      },
      {
        id: 'new-2',
        query: 'headphones',
        results: [{ id: '4', title: 'Sony WH-1000XM4', type: 'product' }],
        timestamp: Date.now() - 1000 * 60 * 5, // 5 minutes ago
        userId: 'user-123',
        tenantId: 'tenant-abc',
        source: 'new'
      }
    ];

    // Add metrics
    this.contextScope.setMetric('newSearchDataRetrieved', mockNewData.length);
    
    return mockNewData;
  }

  /**
   * Process search queries with converged data
   * @param query - Search query parameters
   * @returns Combined search results
   */
  async processConvergedSearch(query: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    try {
      // Retrieve both historical and new search data
      const [historicalData, newData] = await Promise.all([
        this.retrieveHistoricalSearchData(query),
        this.retrieveNewSearchData(query)
      ]);

      // Converge the data
      const convergedData = await this.convergeSearchData(historicalData, newData);

      // Add metadata for analysis
      const enrichedData = convergedData.map(item => ({
        ...item,
        metadata: {
          source: item.hasOwnProperty('source') ? (item as NewSearchData).source : 'historical',
          processedAt: Date.now()
        }
      }));

      return enrichedData;
    } catch (error) {
      this.contextScope.setMetric('convergedSearchProcessingError', 1);
      console.error('Error processing converged search:', error);
      throw error;
    }
  }
}