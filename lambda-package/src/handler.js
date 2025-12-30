"use strict";
// This is the new handler file for the bg-remover service.
// It will contain the logic for the health, process, and status endpoints.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.settings = exports.status = exports.process = exports.health = void 0;
const loader_1 = require("./lib/config/loader");
const crypto_1 = require("crypto");
const types_1 = require("./lib/types");
const multilingual_description_1 = require("./lib/multilingual-description");
const validation_1 = require("./lib/validation");
const resolver_1 = require("./lib/tenant/resolver");
const image_processor_1 = require("./lib/bedrock/image-processor");
const client_eventbridge_1 = require("@aws-sdk/client-eventbridge");
const jwt_validator_1 = require("./lib/auth/jwt-validator");
const client_ssm_1 = require("@aws-sdk/client-ssm");
const client_1 = require("./lib/credits/client");
const job_store_1 = require("./lib/job-store");
const errors_1 = require("./lib/errors");
const logger_1 = require("./lib/logger");
const startTime = Date.now();
const health = async (event) => {
    console.log('Health check requested', {
        path: event.requestContext?.http?.path,
        method: event.requestContext?.http?.method,
    });
    // Check if the request path matches /bg-remover/health
    // Accept both /{stage}/bg-remover/health and /bg-remover/health patterns
    const path = event.requestContext?.http?.path || '';
    const stage = global.process.env.STAGE || 'dev';
    const validPaths = [
        `/bg-remover/health`,
        `/${stage}/bg-remover/health`,
    ];
    // Check if path matches any valid pattern (exact match or ends with pattern)
    const isValidPath = validPaths.some(p => path === p || path.endsWith('/bg-remover/health'));
    if (!isValidPath) {
        console.warn('Health check 404 - unexpected path:', path);
        return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.NOT_FOUND, 'Endpoint not found');
    }
    const checks = [];
    // Check config loading
    try {
        await (0, loader_1.loadConfig)();
        checks.push({ name: 'config', status: 'pass' });
    }
    catch (error) {
        checks.push({
            name: 'config',
            status: 'fail',
            message: error instanceof Error ? error.message : 'Config load failed',
        });
    }
    // Check environment variables
    const requiredEnvVars = ['AWS_REGION'];
    const missingEnvVars = requiredEnvVars.filter((v) => !global.process.env[v]);
    if (missingEnvVars.length === 0) {
        checks.push({ name: 'environment', status: 'pass' });
    }
    else {
        checks.push({
            name: 'environment',
            status: 'fail',
            message: `Missing: ${missingEnvVars.join(', ')}`,
        });
    }
    // Check cache connectivity
    try {
        const { getCacheManager, getAllCacheStats } = await Promise.resolve().then(() => __importStar(require('./lib/cache/cache-manager')));
        const tenantId = global.process.env.TENANT || 'carousel-labs';
        const cacheServiceUrl = global.process.env.CACHE_SERVICE_URL;
        const cacheManager = getCacheManager({
            tenantId,
            cacheServiceUrl,
            enableCacheService: !!cacheServiceUrl && !!tenantId,
            enableMemoryCache: true,
        });
        const stats = cacheManager.getStats();
        const allStats = getAllCacheStats(); // All tenant cache managers
        checks.push({
            name: 'cache',
            status: 'pass',
            message: `Memory: ${stats.memory.entries} entries, Cache Service: ${stats.cacheService.available ? `available (${stats.cacheService.state})` : 'unavailable'}`,
            details: {
                tenantManagers: Object.keys(allStats).length,
                cacheServiceAvailable: stats.cacheService.available || false,
                circuitBreakerState: stats.cacheService.state || 'unknown',
            },
        });
    }
    catch (error) {
        checks.push({
            name: 'cache',
            status: 'fail',
            message: error instanceof Error ? error.message : 'Cache check failed',
        });
    }
    // Determine overall status
    const failedChecks = checks.filter((c) => c.status === 'fail');
    let status = 'healthy';
    if (failedChecks.length > 0) {
        status = failedChecks.length === checks.length ? 'unhealthy' : 'degraded';
    }
    const response = {
        status,
        service: 'bg-remover',
        version: global.process.env.npm_package_version || '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: Date.now() - startTime,
        checks,
    };
    const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
    return {
        statusCode: httpStatus,
        headers: errors_1.DEFAULT_HEADERS,
        body: JSON.stringify(response),
    };
};
exports.health = health;
const process = async (event) => {
    const requestId = (0, errors_1.extractRequestId)(event);
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;
    logger_1.log.debug('Process function called', {
        requestId,
        httpMethod,
        path: event.requestContext?.http?.path,
        hasBody: !!event.body,
    });
    if (httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: errors_1.DEFAULT_HEADERS,
            body: '',
        };
    }
    if (httpMethod !== 'POST') {
        return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.METHOD_NOT_ALLOWED, 'Only POST method is allowed', undefined, requestId);
    }
    // ===== JWT AUTHENTICATION =====
    // Validate JWT token (optional in dev mode, required in prod)
    const stage = global.process.env.STAGE || 'dev';
    const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';
    const authResult = await (0, jwt_validator_1.validateJWTFromEvent)(event, undefined, {
        required: requireAuth
    });
    if (!authResult.isValid && requireAuth) {
        (0, logger_1.logSecurityEvent)('auth_failure', {
            error: authResult.error,
            stage,
            path: event.requestContext?.http?.path,
            requestId,
        });
        const response = (0, errors_1.createErrorResponse)(errors_1.ErrorCode.AUTH_ERROR, 'Valid JWT token required', authResult.error, requestId);
        response.headers = {
            ...response.headers,
            'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
        };
        return response;
    }
    if (authResult.isValid && authResult.userId) {
        (0, logger_1.logSecurityEvent)('auth_success', {
            userId: authResult.userId,
            email: authResult.email,
            groups: authResult.groups,
            requestId,
        });
    }
    else {
        (0, logger_1.logSecurityEvent)('auth_skip', {
            stage,
            requireAuth,
            path: event.requestContext?.http?.path,
            requestId,
        });
    }
    // ===== END JWT AUTHENTICATION =====
    const processingStartTime = Date.now();
    const jobId = (0, crypto_1.randomUUID)();
    // Resolve tenant from request (header, domain, or default)
    const tenant = await (0, resolver_1.resolveTenantFromRequest)(event, stage);
    // Track credit transaction for potential refund on failure
    let creditTransactionId;
    let creditsDebited = false;
    try {
        // Parse and validate request body
        let body;
        try {
            body = JSON.parse(event.body || '{}');
        }
        catch (error) {
            logger_1.log.warn('Invalid JSON in request body', {
                error: error instanceof Error ? error.message : String(error),
                requestId,
            });
            return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON', undefined, requestId);
        }
        const validation = (0, validation_1.validateRequest)(types_1.ProcessRequestSchema, body, 'process-request');
        if (!validation.success) {
            logger_1.log.warn('Request validation failed', {
                tenant,
                errors: validation.error?.details,
                requestId,
            });
            return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, validation.error?.message || 'Request validation failed', validation.error?.details, requestId);
        }
        const validatedRequest = validation.data;
        const { imageUrl, imageBase64, outputFormat, quality, productId, autoTrim, centerSubject, enhanceColors, targetWidth, targetHeight, generateDescription, productName, languages = ['en', 'is'], generatePriceSuggestion = false, generateRatingSuggestion = false, } = validatedRequest;
        logger_1.log.info('Processing image request', {
            jobId,
            tenant,
            productId,
            hasUrl: !!imageUrl,
            hasBase64: !!imageBase64,
            outputFormat,
            quality,
            requestId,
        });
        // ===== CREDITS VALIDATION =====
        // Validate and debit credits before processing (1 credit per image)
        // Only require credits for authenticated requests in production
        const userId = authResult.userId || 'anonymous';
        const creditsRequired = stage === 'prod' || global.process.env.REQUIRE_CREDITS === 'true';
        if (creditsRequired && authResult.isValid && authResult.userId) {
            (0, logger_1.logCreditOperation)('check', true, {
                jobId,
                tenant,
                userId: authResult.userId,
                imageCount: 1,
                requestId,
            });
            const creditResult = await (0, client_1.validateAndDebitCredits)(tenant, authResult.userId, 1, // 1 credit per image
            jobId, productId);
            if (!creditResult.success) {
                (0, logger_1.logCreditOperation)('debit', false, {
                    jobId,
                    tenant,
                    userId: authResult.userId,
                    error: creditResult.error,
                    errorCode: creditResult.errorCode,
                    requestId,
                });
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.INSUFFICIENT_CREDITS, creditResult.error || 'Insufficient credits', { errorCode: creditResult.errorCode, jobId }, requestId);
            }
            // Track successful debit for potential refund
            creditTransactionId = creditResult.transactionId;
            creditsDebited = true;
            (0, logger_1.logCreditOperation)('debit', true, {
                jobId,
                tenant,
                userId: authResult.userId,
                creditsUsed: creditResult.creditsUsed,
                newBalance: creditResult.newBalance,
                transactionId: creditResult.transactionId,
                requestId,
            });
        }
        else if (!creditsRequired) {
            logger_1.log.debug('Credits not required (dev mode)', {
                jobId,
                tenant,
                stage,
                requireCredits: creditsRequired,
                requestId,
            });
        }
        // ===== END CREDITS VALIDATION =====
        // Load tenant-specific configuration
        const config = await (0, resolver_1.loadTenantConfig)(tenant, stage);
        // Process the image
        let result;
        const processingOptions = {
            format: outputFormat,
            quality,
            autoTrim,
            centerSubject,
            enhanceColors,
            targetSize: targetWidth && targetHeight ? { width: targetWidth, height: targetHeight } : undefined,
            generateDescription,
            productName,
        };
        if (imageUrl) {
            result = await (0, image_processor_1.processImageFromUrl)(imageUrl, processingOptions, tenant);
        }
        else if (imageBase64) {
            result = await (0, image_processor_1.processImageFromBase64)(imageBase64, 'image/png', processingOptions, tenant);
        }
        else {
            return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, 'No image provided. Either imageUrl or imageBase64 is required.', { processingTimeMs: Date.now() - processingStartTime }, requestId);
        }
        // For dev: Return base64 data URL instead of uploading to S3
        // In production, this would upload to S3 and return a presigned URL
        const contentType = outputFormat === 'png' ? 'image/png' :
            outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';
        const base64Image = result.outputBuffer.toString('base64');
        const outputUrl = `data:${contentType};base64,${base64Image}`;
        const processingTimeMs = Date.now() - processingStartTime;
        (0, logger_1.logTiming)('image-processing', processingTimeMs, {
            jobId,
            outputSize: base64Image.length,
            originalSize: result.metadata.originalSize,
            processedSize: result.metadata.processedSize,
            tenant,
            outputFormat,
            requestId,
        });
        // Emit CarouselImageProcessed event
        try {
            const eventBridge = new client_eventbridge_1.EventBridgeClient({ region: 'eu-west-1' });
            const eventDetail = {
                file_hash: jobId,
                original_filename: imageUrl ? imageUrl.split('/').pop() || 'input.png' : 'input.png',
                output_filename: 'output.png',
                output_path: '/processed',
                output_key: `processed/${jobId}.png`,
                model_name: 'bedrock-claude-vision',
                processing_time_ms: processingTimeMs,
                timestamp: new Date().toISOString(),
                tenant_id: tenant,
                metadata: result.metadata
            };
            const eventBridgeCommand = {
                Entries: [
                    {
                        Source: 'carousel.bg-remover',
                        DetailType: 'CarouselImageProcessed',
                        Detail: JSON.stringify(eventDetail),
                    },
                ],
            };
            await eventBridge.send(new client_eventbridge_1.PutEventsCommand(eventBridgeCommand));
            (0, logger_1.logServiceCall)('eventbridge', 'putEvents', true, undefined, { jobId, tenant, requestId });
        }
        catch (error) {
            (0, logger_1.logServiceCall)('eventbridge', 'putEvents', false, undefined, {
                jobId,
                tenant,
                error: error instanceof Error ? error.message : String(error),
                requestId,
            });
        }
        // Generate multilingual descriptions if requested
        let multilingualDescription;
        let bilingualDescription;
        if (generateDescription) {
            try {
                // Extract product features from existing description or generate basic ones
                const productFeatures = result.productDescription ? {
                    name: productName || 'Product',
                    category: result.productDescription.category || 'general',
                    colors: result.productDescription.colors,
                    condition: result.productDescription.condition || 'good',
                    brand: result.productDescription.priceSuggestion?.factors.brand,
                } : {
                    name: productName || 'Product',
                    category: 'general',
                    condition: 'good',
                };
                // Generate multilingual descriptions
                multilingualDescription = await multilingual_description_1.multilingualDescriptionGenerator.generateMultilingualDescriptions(productFeatures, languages, generatePriceSuggestion, generateRatingSuggestion);
                // For backwards compatibility, create bilingual description from multilingual
                if (multilingualDescription.en && multilingualDescription.is) {
                    bilingualDescription = {
                        en: multilingualDescription.en,
                        is: multilingualDescription.is,
                    };
                }
            }
            catch (error) {
                logger_1.log.warn('Failed to generate multilingual descriptions', {
                    jobId,
                    error: error instanceof Error ? error.message : String(error),
                    requestId,
                });
                // Continue without descriptions - don't fail the entire request
            }
        }
        (0, logger_1.logResponse)(200, processingTimeMs, { jobId, tenant, requestId });
        return (0, errors_1.createSuccessResponse)({
            success: true,
            jobId,
            outputUrl,
            processingTimeMs,
            metadata: result.metadata,
            productDescription: result.productDescription,
            multilingualDescription,
            bilingualDescription,
            requestId,
        });
    }
    catch (error) {
        const processingTimeMs = Date.now() - processingStartTime;
        logger_1.log.error('Image processing failed', error, {
            jobId,
            processingTimeMs,
            tenant,
            requestId,
        });
        // ===== CREDITS REFUND ON FAILURE =====
        // If we debited credits and processing failed, issue a refund
        if (creditsDebited && creditTransactionId && authResult.userId) {
            logger_1.log.info('Initiating credit refund due to processing failure', {
                jobId,
                tenant,
                userId: authResult.userId,
                originalTransactionId: creditTransactionId,
                requestId,
            });
            try {
                const refundResult = await (0, client_1.refundCredits)(tenant, authResult.userId, // walletId = userId
                1, // 1 credit per image
                jobId, creditTransactionId);
                if (refundResult.success) {
                    (0, logger_1.logCreditOperation)('refund', true, {
                        jobId,
                        tenant,
                        userId: authResult.userId,
                        newBalance: refundResult.newBalance,
                        refundTransactionId: refundResult.transactionId,
                        requestId,
                    });
                }
                else {
                    (0, logger_1.logCreditOperation)('refund', false, {
                        jobId,
                        tenant,
                        userId: authResult.userId,
                        error: refundResult.error,
                        errorCode: refundResult.errorCode,
                        originalTransactionId: creditTransactionId,
                        requestId,
                    });
                    // Note: Don't fail the response - the processing already failed
                    // This should be handled via dead-letter queue or manual reconciliation
                }
            }
            catch (refundError) {
                logger_1.log.error('Credit refund exception', refundError, {
                    jobId,
                    tenant,
                    userId: authResult.userId,
                    originalTransactionId: creditTransactionId,
                    requestId,
                });
            }
        }
        // ===== END CREDITS REFUND =====
        // Use standardized error handling
        (0, logger_1.clearLogContext)();
        return (0, errors_1.handleError)(error, 'process-image', requestId);
    }
};
exports.process = process;
// Job storage is now backed by DynamoDB via src/lib/job-store.ts
// This provides persistent job status storage across Lambda invocations
const status = async (event) => {
    const requestId = (0, errors_1.extractRequestId)(event);
    // Check if the request path matches /bg-remover/status/{jobId}
    const path = event.requestContext?.http?.path || '';
    const pathWithoutStage = path.replace(/^\/[^\/]+/, ''); // Remove stage prefix
    if (!event.pathParameters?.jobId || !pathWithoutStage?.startsWith('/bg-remover/status/')) {
        return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.NOT_FOUND, 'Endpoint not found', undefined, requestId);
    }
    const jobId = event.pathParameters.jobId;
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;
    // ===== JWT AUTHENTICATION =====
    // Status endpoint requires authentication (read-only, but still sensitive)
    const stage = global.process.env.STAGE || 'dev';
    const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';
    const authResult = await (0, jwt_validator_1.validateJWTFromEvent)(event, undefined, {
        required: requireAuth
    });
    if (!authResult.isValid && requireAuth) {
        console.warn('Authentication failed for status endpoint', {
            error: authResult.error,
            jobId,
            stage,
            requestId,
        });
        const response = (0, errors_1.createErrorResponse)(errors_1.ErrorCode.AUTH_ERROR, 'Valid JWT token required', undefined, requestId);
        response.headers = {
            ...response.headers,
            'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
        };
        return response;
    }
    // ===== END JWT AUTHENTICATION =====
    if (httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: errors_1.DEFAULT_HEADERS,
            body: '',
        };
    }
    if (httpMethod === 'GET') {
        try {
            const pathValidation = (0, validation_1.validatePathParams)(event.pathParameters, ['jobId'], 'status-get');
            if (!pathValidation.success) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, pathValidation.error?.message || 'Invalid path parameters', pathValidation.error?.details, requestId);
            }
            const validation = (0, validation_1.validateRequest)(types_1.JobStatusParamsSchema, { jobId }, 'job-status-params');
            if (!validation.success) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, validation.error?.message || 'Invalid job ID format', validation.error?.details, requestId);
            }
            const job = await (0, job_store_1.getJobStatus)(jobId);
            if (!job) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.NOT_FOUND, 'Job not found. The job may have expired or does not exist. Jobs are stored for 24 hours.', { jobId }, requestId);
            }
            return (0, errors_1.createSuccessResponse)({
                jobId: job.jobId,
                status: job.status,
                progress: job.progress,
                result: job.result,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                expiresAt: new Date(new Date(job.createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
            });
        }
        catch (error) {
            console.error('Error fetching job status', {
                jobId,
                error: error instanceof Error ? error.message : 'Unknown error',
                requestId,
            });
            return (0, errors_1.handleError)(error, 'get-job-status', requestId);
        }
    }
    if (httpMethod === 'DELETE') {
        try {
            const pathValidation = (0, validation_1.validatePathParams)(event.pathParameters, ['jobId'], 'status-delete');
            if (!pathValidation.success) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, pathValidation.error?.message || 'Invalid path parameters', pathValidation.error?.details, requestId);
            }
            const validation = (0, validation_1.validateRequest)(types_1.JobStatusParamsSchema, { jobId }, 'job-status-params');
            if (!validation.success) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, validation.error?.message || 'Invalid job ID format', validation.error?.details, requestId);
            }
            const job = await (0, job_store_1.getJobStatus)(jobId);
            if (!job) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.NOT_FOUND, 'Job not found', { jobId }, requestId);
            }
            if (job.status !== 'pending' && job.status !== 'processing') {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.CONFLICT, `Cannot cancel job - job is already ${job.status}`, { jobId, currentStatus: job.status }, requestId);
            }
            // Update job status to cancelled/failed
            await (0, job_store_1.updateJobStatus)(jobId, {
                status: 'failed',
                result: {
                    success: false,
                    error: 'Job cancelled by user',
                },
            });
            return (0, errors_1.createSuccessResponse)({
                jobId,
                status: 'cancelled',
                message: 'Job has been cancelled',
            });
        }
        catch (error) {
            console.error('Error cancelling job', {
                jobId,
                error: error instanceof Error ? error.message : 'Unknown error',
                requestId,
            });
            return (0, errors_1.handleError)(error, 'cancel-job', requestId);
        }
    }
    return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.METHOD_NOT_ALLOWED, 'Method not allowed', undefined, requestId);
};
exports.status = status;
/**
 * Settings Handler
 * GET /bg-remover/settings - Retrieve similarity detection settings
 * PUT /bg-remover/settings - Update similarity detection settings
 */
const settings = async (event) => {
    const requestId = (0, errors_1.extractRequestId)(event);
    console.log('Settings handler invoked', {
        httpMethod: event.requestContext?.http?.method,
        headers: event.headers,
        requestId,
    });
    const httpMethod = event.requestContext?.http?.method || 'GET';
    const stage = global.process.env.STAGE || 'dev';
    // Resolve tenant using proper tenant resolution logic
    const { resolveTenantFromRequest } = await Promise.resolve().then(() => __importStar(require('./lib/tenant/resolver')));
    const tenant = await resolveTenantFromRequest(event, stage);
    console.log('Resolved tenant for settings request', {
        tenant,
        host: event.headers?.host,
        requestId,
    });
    // Handle OPTIONS preflight
    if (httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: errors_1.DEFAULT_HEADERS,
            body: '',
        };
    }
    // ===== JWT AUTHENTICATION =====
    // Settings endpoint requires authentication (sensitive configuration)
    const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';
    // Load tenant-specific Cognito configuration for JWT validation
    const { loadTenantCognitoConfig } = await Promise.resolve().then(() => __importStar(require('./lib/tenant/cognito-config')));
    const cognitoConfig = await loadTenantCognitoConfig(tenant, stage);
    console.log('Loaded Cognito config for tenant', {
        tenant,
        userPoolId: cognitoConfig.userPoolId,
        issuer: cognitoConfig.issuer,
        requestId,
    });
    const authResult = await (0, jwt_validator_1.validateJWTFromEvent)(event, cognitoConfig, {
        required: requireAuth
    });
    if (!authResult.isValid && requireAuth) {
        console.warn('Authentication failed for settings endpoint', {
            error: authResult.error,
            stage,
            path: event.requestContext?.http?.path,
            requestId,
        });
        const response = (0, errors_1.createErrorResponse)(errors_1.ErrorCode.AUTH_ERROR, 'Valid JWT token required', authResult.error, requestId);
        response.headers = {
            ...response.headers,
            'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
        };
        return response;
    }
    if (authResult.isValid && authResult.userId) {
        console.info('Authenticated settings request', {
            userId: authResult.userId,
            email: authResult.email,
            method: httpMethod,
            requestId,
        });
    }
    // ===== END JWT AUTHENTICATION =====
    const ssmClient = new client_ssm_1.SSMClient({ region: global.process.env.AWS_REGION || 'eu-west-1' });
    const ssmPath = `/tf/${stage}/${tenant}/services/bg-remover/settings`;
    // Default settings (includes both legacy duplicate detection and new Product Identity)
    const defaultSettings = {
        // Legacy duplicate detection settings
        detectDuplicates: true,
        groupByColor: true,
        duplicateThreshold: 0.85, // Lowered from 0.95 for bg-removed images
        colorGroups: 3,
        maxImagesPerGroup: 10,
        // Product Identity Detection settings
        productIdentity: {
            enabled: true,
            threshold: 0.70,
            minGroupSize: 1,
            maxGroupSize: 6,
            useRekognition: true,
            signalWeights: {
                spatial: 0.40,
                feature: 0.35,
                semantic: 0.15,
                composition: 0.05,
                background: 0.05,
            },
        },
    };
    // GET - Retrieve settings
    if (httpMethod === 'GET') {
        try {
            const command = new client_ssm_1.GetParameterCommand({
                Name: ssmPath,
                WithDecryption: false,
            });
            const response = await ssmClient.send(command);
            const settings = response.Parameter?.Value
                ? JSON.parse(response.Parameter.Value)
                : defaultSettings;
            console.log('Retrieved settings from SSM', { ssmPath, settings, requestId });
            return (0, errors_1.createSuccessResponse)({ settings });
        }
        catch (error) {
            if (error.name === 'ParameterNotFound') {
                console.log('Settings parameter not found, returning defaults', { ssmPath, requestId });
                return (0, errors_1.createSuccessResponse)({ settings: defaultSettings });
            }
            console.error('Error retrieving settings from SSM', {
                error: error.message,
                ssmPath,
                requestId,
            });
            return (0, errors_1.handleError)(error, 'get-settings', requestId);
        }
    }
    // PUT - Update settings
    if (httpMethod === 'PUT') {
        try {
            const body = JSON.parse(event.body || '{}');
            const { settings } = body;
            // Validate settings
            if (!settings || typeof settings !== 'object') {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, 'Settings object is required', undefined, requestId);
            }
            // Validate settings fields (legacy duplicate detection)
            const validationErrors = [];
            if (settings.detectDuplicates !== undefined && typeof settings.detectDuplicates !== 'boolean') {
                validationErrors.push('detectDuplicates must be a boolean');
            }
            if (settings.groupByColor !== undefined && typeof settings.groupByColor !== 'boolean') {
                validationErrors.push('groupByColor must be a boolean');
            }
            if (settings.duplicateThreshold !== undefined && (typeof settings.duplicateThreshold !== 'number' || settings.duplicateThreshold < 0 || settings.duplicateThreshold > 1)) {
                validationErrors.push('duplicateThreshold must be a number between 0 and 1');
            }
            if (settings.colorGroups !== undefined && (typeof settings.colorGroups !== 'number' || settings.colorGroups < 1 || settings.colorGroups > 10)) {
                validationErrors.push('colorGroups must be a number between 1 and 10');
            }
            if (settings.maxImagesPerGroup !== undefined && (typeof settings.maxImagesPerGroup !== 'number' || settings.maxImagesPerGroup < 1)) {
                validationErrors.push('maxImagesPerGroup must be a positive number');
            }
            // Validate Product Identity settings
            if (settings.productIdentity) {
                const pi = settings.productIdentity;
                if (pi.enabled !== undefined && typeof pi.enabled !== 'boolean') {
                    validationErrors.push('productIdentity.enabled must be a boolean');
                }
                if (pi.threshold !== undefined && (typeof pi.threshold !== 'number' || pi.threshold < 0 || pi.threshold > 1)) {
                    validationErrors.push('productIdentity.threshold must be a number between 0 and 1');
                }
                if (pi.minGroupSize !== undefined && (typeof pi.minGroupSize !== 'number' || pi.minGroupSize < 1)) {
                    validationErrors.push('productIdentity.minGroupSize must be a positive number');
                }
                if (pi.maxGroupSize !== undefined && (typeof pi.maxGroupSize !== 'number' || pi.maxGroupSize < 1)) {
                    validationErrors.push('productIdentity.maxGroupSize must be a positive number');
                }
                if (pi.useRekognition !== undefined && typeof pi.useRekognition !== 'boolean') {
                    validationErrors.push('productIdentity.useRekognition must be a boolean');
                }
                if (pi.signalWeights) {
                    const sw = pi.signalWeights;
                    const weightFields = ['spatial', 'feature', 'semantic', 'composition', 'background'];
                    for (const field of weightFields) {
                        if (sw[field] !== undefined && (typeof sw[field] !== 'number' || sw[field] < 0 || sw[field] > 1)) {
                            validationErrors.push(`productIdentity.signalWeights.${field} must be a number between 0 and 1`);
                        }
                    }
                    // Validate sum of weights equals 1.0 (with tolerance for floating point)
                    const sum = (sw.spatial ?? 0) + (sw.feature ?? 0) + (sw.semantic ?? 0) + (sw.composition ?? 0) + (sw.background ?? 0);
                    if (Math.abs(sum - 1.0) > 0.01) {
                        validationErrors.push('productIdentity.signalWeights must sum to 1.0');
                    }
                }
            }
            if (validationErrors.length > 0) {
                return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.VALIDATION_ERROR, 'Invalid settings', validationErrors, requestId);
            }
            // Save to SSM
            const command = new client_ssm_1.PutParameterCommand({
                Name: ssmPath,
                Value: JSON.stringify(settings),
                Type: 'String',
                Overwrite: true,
                Description: 'BG-Remover similarity detection settings',
            });
            await ssmClient.send(command);
            console.log('Saved settings to SSM', { ssmPath, settings, requestId });
            return (0, errors_1.createSuccessResponse)({
                success: true,
                settings,
                message: 'Settings saved successfully',
            });
        }
        catch (error) {
            console.error('Error saving settings to SSM', {
                error: error.message,
                ssmPath,
                requestId,
            });
            return (0, errors_1.handleError)(error, 'save-settings', requestId);
        }
    }
    return (0, errors_1.createErrorResponse)(errors_1.ErrorCode.METHOD_NOT_ALLOWED, 'Method not allowed', undefined, requestId);
};
exports.settings = settings;
/**
 * Process Worker - Background image processing
 *
 * This is imported from the new async pattern handlers.
 * It's exported here to maintain compatibility with serverless.yml
 */
// Commented out to prevent loading Next.js dependencies at Lambda init
// Each handler has its own entry file in src/handlers/
// export { processWorker } from './handlers/process-worker-handler';
/**
 * Create Products - Multi-image product creation endpoint
 *
 * Processes image groups, uploads to S3, and creates products in carousel-api.
 * Connects the existing BulkUploadWizard UI to product creation.
 */
// Commented out to prevent loading Next.js dependencies at Lambda init
// Each handler has its own entry file in src/handlers/
// export { createProducts } from './handlers/create-products-handler';
