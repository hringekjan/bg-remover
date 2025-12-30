import { BaseHandler } from './base-handler';
import { loadConfig } from '../lib/config/loader';

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  service: string;
  version: string;
  timestamp: string;
  uptime: number;
  checks: {
    name: string;
    status: 'pass' | 'fail';
    message?: string;
  }[];
}

const startTime = Date.now();

export class HealthHandler extends BaseHandler {
  async handle(event: any): Promise<any> {
    console.log('Health check requested', {
      path: event.requestContext?.http?.path,
      method: event.requestContext?.http?.method,
    });

    // Check if the request path matches /bg-remover/health
    // Accept both /{stage}/bg-remover/health and /bg-remover/health patterns
    const path = event.requestContext?.http?.path || '';
    const stage = this.context.stage;
    const validPaths = [
      `/bg-remover/health`,
      `/${stage}/bg-remover/health`,
    ];

    // Check if path matches any valid pattern (exact match or ends with pattern)
    const isValidPath = validPaths.some(p => path === p || path.endsWith('/bg-remover/health'));

    if (!isValidPath) {
      console.warn('Health check 404 - unexpected path:', path);
      return this.createJsonResponse({ message: 'Not Found' }, 404);
    }

    const checks: HealthResponse['checks'] = [];

    // Check config loading
    try {
      await loadConfig();
      checks.push({ name: 'config', status: 'pass' });
    } catch (error) {
      checks.push({
        name: 'config',
        status: 'fail',
        message: error instanceof Error ? error.message : 'Config load failed',
      });
    }

    // Check environment variables
    const requiredEnvVars = ['AWS_REGION'];
    const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);

    if (missingEnvVars.length === 0) {
      checks.push({ name: 'environment', status: 'pass' });
    } else {
      checks.push({
        name: 'environment',
        status: 'fail',
        message: `Missing: ${missingEnvVars.join(', ')}`,
      });
    }

    console.log('Environment check complete, checks so far:', checks.length);

    // Check cache connectivity
    console.log('Starting cache check...');
    try {
      console.log('Getting cache manager stats...');
      const stats = this.context.cacheManager.getStats();
      console.log('Cache stats retrieved:', JSON.stringify(stats, null, 2));
      checks.push({
        name: 'cache',
        status: 'pass',
        message: `Memory: ${stats.memory.entries} entries, Cache Service: ${stats.cacheService.available ? `available (${stats.cacheService.state})` : 'unavailable'}`
      });
      console.log('Cache check passed');
    } catch (error) {
      console.error('Cache check error:', error);
      checks.push({
        name: 'cache',
        status: 'fail',
        message: error instanceof Error ? error.message : 'Cache check failed',
      });
    }

    // Determine overall status
    const failedChecks = checks.filter((c) => c.status === 'fail');
    let status: HealthResponse['status'] = 'healthy';

    if (failedChecks.length > 0) {
      status = failedChecks.length === checks.length ? 'unhealthy' : 'degraded';
    }

    const response: HealthResponse = {
      status,
      service: 'bg-remover',
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: Date.now() - startTime,
      checks,
    };

    const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

    return this.createJsonResponse(response, httpStatus);
  }
}

// Export the handler function for Lambda
export const health = async (event: any) => {
  const handler = new HealthHandler();
  return handler.handle(event);
};