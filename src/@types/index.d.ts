/**
 * Type stubs for @carousellabs/backend-kit
 * Re-exports from dist files since backend-kit uses inline types
 */

declare module '@carousellabs/backend-kit' {
  // Cache class
  export class EmbeddingCache {
    constructor(options?: { maxSizeBytes?: number; ttlMs?: number });
    get(key: string): Promise<number[] | undefined>;
    set(key: string, value: number[]): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    getCacheStats(): {
      hits: number;
      misses: number;
      totalRequests: number;
      hitRate: number;
      sizeBytes: number;
      sizePercent: number;
      evictions: number;
      entryCount: number;
    };
  }

  // Lambda utilities
  export function withMagrathean(handler: any, options: any): any;
  export function httpJson(handler: any): any;
  export function httpResponse(handler: any): any;

  // Config utilities
  export function loadAppConfig(tenant: string, app: string, stage: string): Promise<any>;
  export function loadConfigs(tenant: string, stage: string): Promise<any>;
  export function extractAppFromEvent(event: any): string;
  export function extractTenantFromEvent(event: any): string;

  // Auth utilities
  export function withAuth(options: any): any;
  export function verifyJwt(token: string, config: any): Promise<any>;

  // Cost tracking
  export function withCost(handler: any, options: any): any;
  export class EventBridgeEmitter {
    constructor(options: any);
    emit(event: any): Promise<void>;
  }

  // Other exports
  export class ConfigLoader {
    constructor(options?: any);
    load(tenant: string, app?: string): Promise<any>;
  }
}

// Lambda auth module
declare module '@carousellabs/backend-kit/auth' {
  import * as main from '@carousellabs/backend-kit';
  export = main;
}

// Lambda utilities module
declare module '@carousellabs/backend-kit/lambda' {
  import * as main from '@carousellabs/backend-kit';
  export = main;
}

// Observability module
declare module '@carousellabs/backend-kit/observability' {
  import * as main from '@carousellabs/backend-kit';
  export = main;
}
