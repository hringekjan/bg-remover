import { ContextScope } from '@carousellabs/context-scope';
import { SearchAdapter } from '../lib/middleware/context-scope';

// Test the SearchAdapter functionality
async function testSearchAdapter() {
  console.log('Testing SearchAdapter...');
  
  // Create a mock context scope
  const mockContextScope = new ContextScope();
  
  // Create the search adapter instance
  const searchAdapter = new SearchAdapter(mockContextScope);
  
  // Test search method
  console.log('Testing search method...');
  const searchResult = await searchAdapter.search({ q: 'test query' });
  console.log('Search result:', JSON.stringify(searchResult, null, 2));
  
  // Test telemetry method
  console.log('Testing telemetry method...');
  const telemetryResult = await searchAdapter.fetchTelemetry({ type: 'usage' });
  console.log('Telemetry result:', JSON.stringify(telemetryResult, null, 2));
  
  console.log('SearchAdapter tests completed.');
}

// Run the test
testSearchAdapter().catch(console.error);