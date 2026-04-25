# Search Data Convergence

This document describes the implementation of search data convergence functionality within the bg-remover service. The goal is to integrate both historical and new search data into a unified view for improved search capabilities.

## Overview

The search data convergence feature combines historical search data with newly generated search data to provide a more comprehensive search experience. This is particularly useful for analyzing user behavior patterns and improving search relevance over time.

## Key Components

### 1. SearchDataConvergenceService

The core service responsible for:
- Retrieving historical search data from storage systems
- Fetching new search data from recent search tracking systems
- Converging both datasets while deduplicating results
- Providing unified search results with metadata enrichment

### 2. Data Models

#### HistoricalSearchData
```typescript
interface HistoricalSearchData {
  id: string;
  query: string;
  results: Record<string, unknown>[];
  timestamp: number;
  userId: string;
  tenantId: string;
}
```

#### NewSearchData
```typescript
interface NewSearchData {
  id: string;
  query: string;
  results: Record<string, unknown>[];
  timestamp: number;
  userId: string;
  tenantId: string;
  source: 'new' | 'historical';
}
```

### 3. Convergence Logic

The convergence process:
1. Retrieves historical data from storage
2. Retrieves new search data from tracking systems
3. Combines both data sets
4. Removes duplicates based on query and user context
5. Sorts results by timestamp (newest first)
6. Enriches results with metadata for analysis

## Integration Points

### Handler Integration
The convergence service is integrated directly into the search endpoint handling within `src/handler.ts`. When `/search` or `/query` endpoints are accessed, the service automatically:
- Processes both historical and new search data
- Returns merged results
- Maintains proper RBAC enforcement
- Tracks relevant metrics

## Configuration

The service relies on the following environment variables:
- `HISTORICAL_SEARCH_STORAGE`: Storage location for historical data (default: mock implementation)
- `NEW_SEARCH_TRACKING`: System for tracking new searches (default: mock implementation)

## Usage Examples

### Basic Search with Convergence
```
GET /search?q=laptop&userId=user-123&tenantId=tenant-abc
```

Response includes merged results from both historical and new searches:
```json
{
  "results": [
    {
      "id": "new-1",
      "query": "laptop",
      "results": [...],
      "timestamp": 1704067200000,
      "userId": "user-123",
      "tenantId": "tenant-abc",
      "source": "new",
      "metadata": {
        "source": "new",
        "processedAt": 1704067200000
      }
    },
    {
      "id": "hist-1",
      "query": "laptop",
      "results": [...],
      "timestamp": 1703980800000,
      "userId": "user-123",
      "tenantId": "tenant-abc",
      "source": "historical",
      "metadata": {
        "source": "historical",
        "processedAt": 1704067200000
      }
    }
  ],
  "timestamp": 1704067200000
}
```

## Monitoring & Metrics

The service tracks the following metrics:
- `searchDataConvergenceSuccess`: Successful convergence operations
- `searchDataItemsProcessed`: Total search items processed
- `historicalSearchDataRetrieved`: Number of historical search items retrieved
- `newSearchDataRetrieved`: Number of new search items retrieved
- `convergedSearchProcessingError`: Errors during converged search processing

## Future Enhancements

1. Implement actual data retrieval from persistent storage systems
2. Add advanced deduplication algorithms
3. Include machine learning-based relevance scoring
4. Enable filtering by date ranges for historical data
5. Add caching mechanisms for frequently accessed search combinations