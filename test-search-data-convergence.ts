import { SearchDataConvergenceService } from './src/services/search-data-convergence';

// This is a simple test to validate the functionality
async function testSearchDataConvergence() {
  console.log('Testing Search Data Convergence Service...');
  
  // Mock ContextScope for testing
  const mockContextScope = {
    setMetric: (metric: string, value: number) => {
      console.log(`Set metric ${metric}: ${value}`);
    }
  } as any;
  
  const convergenceService = new SearchDataConvergenceService(mockContextScope);
  
  // Test convergence with sample data
  const historicalData = [
    {
      id: 'hist-1',
      query: 'laptop',
      results: [{ id: '1', title: 'MacBook Pro', type: 'product' }],
      timestamp: Date.now() - 1000 * 60 * 60 * 24,
      userId: 'user-123',
      tenantId: 'tenant-abc'
    }
  ];
  
  const newData = [
    {
      id: 'new-1',
      query: 'laptop',
      results: [{ id: '2', title: 'Dell XPS', type: 'product' }],
      timestamp: Date.now(),
      userId: 'user-123',
      tenantId: 'tenant-abc',
      source: 'new'
    }
  ];
  
  try {
    const convergedData = await convergenceService.convergeSearchData(historicalData, newData);
    console.log('Converged data:', convergedData);
    console.log('Test completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testSearchDataConvergence();