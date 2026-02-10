#!/usr/bin/env node
/**
 * Auto-attach JWT authorizer to bg-remover API Gateway routes
 *
 * This script runs after serverless deployment to ensure all protected routes
 * have the multi-tenant JWT authorizer attached at the API Gateway level.
 *
 * Why needed: Shared API Gateway is managed externally (Terraform/SSM).
 * Serverless Framework cannot configure authorizers for externally managed gateways.
 *
 * Usage: npm run attach-authorizer
 * Or: STAGE=prod npm run attach-authorizer
 */

const { execSync } = require('child_process');

const stage = process.env.STAGE || 'dev';

// Routes that require JWT authentication
// Add new protected routes here as you create them
const PROTECTED_ROUTES = [
  'POST /carousel/bg-remover/upload-urls',
  'POST /carousel/bg-remover/process',
  'POST /carousel/bg-remover/batch',
  'POST /carousel/bg-remover/group-images',
  'POST /carousel/bg-remover/create-product',
  'POST /carousel/bg-remover/create-products',
  'POST /carousel/bg-remover/process-groups',
  'GET /carousel/bg-remover/status/{jobId}',
  'GET /carousel/bg-remover/stream/{jobId}',
];

// Routes that should remain public (health checks, etc.)
const PUBLIC_ROUTES = [
  'ANY /carousel/bg-remover/health',
  'OPTIONS /carousel/bg-remover/{proxy+}',  // CORS preflight
];

function exec(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    }).trim();
  } catch (error) {
    if (options.ignoreError) {
      return null;
    }
    throw error;
  }
}

async function attachAuthorizers() {
  console.log('\n🔐 Attaching JWT authorizers to bg-remover routes...');
  console.log(`📍 Stage: ${stage}\n`);

  // Step 1: Get API Gateway ID from SSM
  console.log('1️⃣  Fetching API Gateway ID from SSM...');
  const apiId = exec(
    `aws ssm get-parameter --name /tf/${stage}/platform/api-gateway/id --query Parameter.Value --output text`,
    { silent: true }
  );

  if (!apiId) {
    console.error('❌ Failed to get API Gateway ID from SSM');
    process.exit(1);
  }
  console.log(`   ✅ API Gateway ID: ${apiId}`);

  // Step 2: Get JWT authorizer ID
  console.log('\n2️⃣  Fetching multi-tenant JWT authorizer...');
  const authorizerId = exec(
    `aws apigatewayv2 get-authorizers --api-id ${apiId} --query "Items[?Name=='multi-tenant-jwt-authorizer'].AuthorizerId" --output text`,
    { silent: true }
  );

  if (!authorizerId) {
    console.error('❌ JWT authorizer not found. Expected authorizer named "multi-tenant-jwt-authorizer"');
    console.error('   Run: aws apigatewayv2 get-authorizers --api-id ' + apiId);
    process.exit(1);
  }
  console.log(`   ✅ Authorizer ID: ${authorizerId}`);

  // Step 3: Attach authorizer to each protected route
  console.log('\n3️⃣  Attaching authorizers to protected routes...');

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const routeKey of PROTECTED_ROUTES) {
    try {
      // Get route ID
      const routeId = exec(
        `aws apigatewayv2 get-routes --api-id ${apiId} --query "Items[?RouteKey=='${routeKey}'].RouteId" --output text`,
        { silent: true, ignoreError: true }
      );

      if (!routeId) {
        console.log(`   ⚠️  ${routeKey} - route not found (not yet deployed)`);
        skipCount++;
        continue;
      }

      // Check current authorization status
      const currentAuth = exec(
        `aws apigatewayv2 get-route --api-id ${apiId} --route-id ${routeId} --query AuthorizationType --output text`,
        { silent: true, ignoreError: true }
      );

      if (currentAuth === 'CUSTOM') {
        console.log(`   ✓  ${routeKey} - already has CUSTOM authorizer`);
        successCount++;
        continue;
      }

      // Attach authorizer
      exec(
        `aws apigatewayv2 update-route --api-id ${apiId} --route-id ${routeId} --authorization-type CUSTOM --authorizer-id ${authorizerId}`,
        { silent: true }
      );

      console.log(`   ✅ ${routeKey} - authorizer attached`);
      successCount++;
    } catch (error) {
      console.error(`   ❌ ${routeKey} - failed: ${error.message}`);
      errorCount++;
    }
  }

  // Step 4: Verify public routes remain public
  console.log('\n4️⃣  Verifying public routes...');

  for (const routeKey of PUBLIC_ROUTES) {
    try {
      const routeId = exec(
        `aws apigatewayv2 get-routes --api-id ${apiId} --query "Items[?RouteKey=='${routeKey}'].RouteId" --output text`,
        { silent: true, ignoreError: true }
      );

      if (!routeId) {
        console.log(`   ⚠️  ${routeKey} - route not found`);
        continue;
      }

      const currentAuth = exec(
        `aws apigatewayv2 get-route --api-id ${apiId} --route-id ${routeId} --query AuthorizationType --output text`,
        { silent: true, ignoreError: true }
      );

      if (currentAuth === 'NONE') {
        console.log(`   ✓  ${routeKey} - public (no authorizer)`);
      } else {
        console.log(`   ⚠️  ${routeKey} - has ${currentAuth} authorizer (expected NONE)`);
      }
    } catch (error) {
      console.error(`   ❌ ${routeKey} - failed to check: ${error.message}`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Summary:');
  console.log(`   ✅ Success: ${successCount} routes`);
  if (skipCount > 0) {
    console.log(`   ⚠️  Skipped: ${skipCount} routes (not deployed yet)`);
  }
  if (errorCount > 0) {
    console.log(`   ❌ Errors: ${errorCount} routes`);
  }
  console.log('='.repeat(60) + '\n');

  if (errorCount > 0) {
    console.error('⚠️  Some routes failed to update. Check errors above.');
    process.exit(1);
  }

  console.log('✅ All protected routes have JWT authorizer attached!\n');
}

// Run the script
attachAuthorizers().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
