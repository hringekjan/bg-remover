/**
 * GET /api/health - Health Check Endpoint
 *
 * Returns service health status and configuration info.
 */

import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config/loader';

export const runtime = 'nodejs';

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

export async function GET(): Promise<NextResponse<HealthResponse>> {
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

  return NextResponse.json(response, { status: httpStatus });
}
