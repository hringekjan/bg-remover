/**
 * Credits Client for BG Remover Service
 *
 * Provides credit validation and consumption for image processing.
 * Communicates with the credits-service via internal API calls.
 */

import { getCacheManager } from '../cache/cache-manager';
import { buildCacheKey, CacheTTL } from '../cache/constants';

// Using string type for TenantId to avoid dependency on backend-kit build types
// TenantId is semantically a string identifier like 'carousel-labs' or 'hringekjan'
type TenantId = string;

// Credits API base URL (internal API Gateway)
const CREDITS_API_BASE = process.env.CREDITS_API_URL || 'https://api.dev.carousellabs.co/carousel/credits';

// Credits per image processed
const CREDITS_PER_IMAGE = 1;

/**
 * Credit balance check result
 */
export interface CreditBalanceCheck {
  walletId: string;
  balance: number;
  requested: number;
  sufficient: boolean;
  shortfall: number;
}

/**
 * Credit operation result
 */
export interface CreditOperationResult {
  success: boolean;
  newBalance: number;
  transactionId?: string;
  error?: string;
  errorCode?: string;
}

/**
 * Check if user has sufficient credits for processing
 * Uses hybrid L1 (memory) + L2 (cache-service) caching for check results
 */
export async function checkCredits(
  tenantId: TenantId,
  walletId: string,
  imageCount: number = 1
): Promise<CreditBalanceCheck> {
  const requiredCredits = imageCount * CREDITS_PER_IMAGE;
  const cacheKey = buildCacheKey.creditsCheck(tenantId, walletId);
  const cacheManager = getCacheManager();

  // Try cache first (L1 memory + L2 cache-service)
  const cached = await cacheManager.get<CreditBalanceCheck>(cacheKey);
  if (cached) {
    console.debug('Credits check cache hit', {
      walletId,
      tenantId,
      cachedBalance: cached.balance
    });
    // Update cached result with current request
    return {
      ...cached,
      requested: requiredCredits,
      sufficient: cached.balance >= requiredCredits,
      shortfall: Math.max(0, requiredCredits - cached.balance),
    };
  }

  try {
    const response = await fetch(`${CREDITS_API_BASE}/wallets/${walletId}/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
      },
      body: JSON.stringify({ amount: requiredCredits }),
    });

    if (!response.ok) {
      console.error('Credits check failed', {
        status: response.status,
        walletId,
        tenantId,
      });

      // Return insufficient balance on API error
      return {
        walletId,
        balance: 0,
        requested: requiredCredits,
        sufficient: false,
        shortfall: requiredCredits,
      };
    }

    const result = await response.json();
    const checkResult = result.data as CreditBalanceCheck;

    // Cache successful checks (L1 + L2)
    if (checkResult.sufficient || checkResult.balance > 0) {
      await cacheManager.set(cacheKey, checkResult, {
        memoryTtl: CacheTTL.CREDITS_CHECK.memory,
        cacheServiceTtl: CacheTTL.CREDITS_CHECK.service,
      });
      console.debug('Credits check result cached', {
        walletId,
        tenantId,
        balance: checkResult.balance
      });
    }

    return checkResult;
  } catch (error) {
    console.error('Credits API error', {
      error: error instanceof Error ? error.message : String(error),
      walletId,
      tenantId,
    });

    // Return insufficient balance on error
    return {
      walletId,
      balance: 0,
      requested: requiredCredits,
      sufficient: false,
      shortfall: requiredCredits,
    };
  }
}

/**
 * Debit credits for image processing
 * Returns transaction details for potential rollback
 */
export async function debitCredits(
  tenantId: TenantId,
  walletId: string,
  imageCount: number = 1,
  jobId: string,
  productId?: string
): Promise<CreditOperationResult> {
  const amount = imageCount * CREDITS_PER_IMAGE;

  try {
    const response = await fetch(`${CREDITS_API_BASE}/wallets/${walletId}/debit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
      },
      body: JSON.stringify({
        amount,
        sourceType: 'bg_remover',
        sourceId: jobId,
        description: `Background removal for ${imageCount} image(s)`,
        idempotencyKey: `bg-remover:${jobId}`,
        metadata: {
          jobId,
          productId,
          imageCount,
        },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      // Handle 402 Payment Required (insufficient credits)
      if (response.status === 402) {
        return {
          success: false,
          newBalance: result.data?.balance || 0,
          error: 'Insufficient credits',
          errorCode: 'INSUFFICIENT_CREDITS',
        };
      }

      return {
        success: false,
        newBalance: 0,
        error: result.error || 'Credit debit failed',
        errorCode: result.code || 'DEBIT_FAILED',
      };
    }

    // Invalidate credits cache after successful debit
    const cacheManager = getCacheManager();
    await cacheManager.delete(buildCacheKey.creditsCheck(tenantId, walletId));
    await cacheManager.delete(buildCacheKey.creditsBalance(tenantId, walletId));
    console.debug('Credits cache invalidated after debit', { walletId, tenantId });

    return {
      success: true,
      newBalance: result.data.newBalance,
      transactionId: result.data.transaction?.transactionId,
    };
  } catch (error) {
    console.error('Credits debit error', {
      error: error instanceof Error ? error.message : String(error),
      walletId,
      tenantId,
      jobId,
    });

    return {
      success: false,
      newBalance: 0,
      error: error instanceof Error ? error.message : 'Credit debit failed',
      errorCode: 'API_ERROR',
    };
  }
}

/**
 * Refund credits after processing failure
 */
export async function refundCredits(
  tenantId: TenantId,
  walletId: string,
  amount: number,
  jobId: string,
  originalTransactionId: string
): Promise<CreditOperationResult> {
  try {
    const response = await fetch(`${CREDITS_API_BASE}/wallets/${walletId}/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
      },
      body: JSON.stringify({
        amount,
        sourceType: 'refund',
        sourceId: originalTransactionId,
        description: `Refund for failed bg-remover job ${jobId}`,
        idempotencyKey: `bg-remover-refund:${jobId}`,
        metadata: {
          jobId,
          originalTransactionId,
          reason: 'processing_failure',
        },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      return {
        success: false,
        newBalance: 0,
        error: result.error || 'Credit refund failed',
        errorCode: result.code || 'REFUND_FAILED',
      };
    }

    // Invalidate credits cache after successful refund
    const cacheManager = getCacheManager();
    await cacheManager.delete(buildCacheKey.creditsCheck(tenantId, walletId));
    await cacheManager.delete(buildCacheKey.creditsBalance(tenantId, walletId));
    console.debug('Credits cache invalidated after refund', { walletId, tenantId });

    return {
      success: true,
      newBalance: result.data.newBalance,
      transactionId: result.data.transaction?.transactionId,
    };
  } catch (error) {
    console.error('Credits refund error', {
      error: error instanceof Error ? error.message : String(error),
      walletId,
      tenantId,
      jobId,
    });

    return {
      success: false,
      newBalance: 0,
      error: error instanceof Error ? error.message : 'Credit refund failed',
      errorCode: 'API_ERROR',
    };
  }
}

/**
 * Get wallet balance
 */
export async function getWalletBalance(
  tenantId: TenantId,
  walletId: string
): Promise<{ balance: number; error?: string }> {
  try {
    const response = await fetch(`${CREDITS_API_BASE}/wallets/${walletId}`, {
      method: 'GET',
      headers: {
        'X-Tenant-Id': tenantId,
      },
    });

    if (!response.ok) {
      return { balance: 0, error: 'Wallet not found' };
    }

    const result = await response.json();
    return { balance: result.data.balance };
  } catch (error) {
    return {
      balance: 0,
      error: error instanceof Error ? error.message : 'Failed to get balance',
    };
  }
}

/**
 * Validate and debit credits in one operation
 * Returns error response if insufficient credits
 */
export async function validateAndDebitCredits(
  tenantId: TenantId,
  userId: string,
  imageCount: number,
  jobId: string,
  productId?: string
): Promise<{
  success: boolean;
  transactionId?: string;
  creditsUsed?: number;
  newBalance?: number;
  error?: string;
  errorCode?: string;
  httpStatus?: number;
}> {
  // Use userId as walletId (standard pattern)
  const walletId = userId;

  // Check balance first
  const balanceCheck = await checkCredits(tenantId, walletId, imageCount);

  if (!balanceCheck.sufficient) {
    return {
      success: false,
      error: `Insufficient credits. Balance: ${balanceCheck.balance}, Required: ${balanceCheck.requested}`,
      errorCode: 'INSUFFICIENT_CREDITS',
      httpStatus: 402,
    };
  }

  // Debit credits
  const debitResult = await debitCredits(tenantId, walletId, imageCount, jobId, productId);

  if (!debitResult.success) {
    return {
      success: false,
      error: debitResult.error,
      errorCode: debitResult.errorCode,
      httpStatus: debitResult.errorCode === 'INSUFFICIENT_CREDITS' ? 402 : 500,
    };
  }

  return {
    success: true,
    transactionId: debitResult.transactionId,
    creditsUsed: imageCount * CREDITS_PER_IMAGE,
    newBalance: debitResult.newBalance,
  };
}
