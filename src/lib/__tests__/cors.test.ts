/**
 * Comprehensive tests for CORS configuration
 *
 * Goal: Achieve 70%+ code coverage for cors.ts
 *
 * Test Coverage:
 * - validateOrigin() for tenant-specific origins
 * - Invalid origin handling
 * - createTenantCorsHeaders() for all required headers
 * - Multi-tenant isolation
 * - Security validation (no wildcards, exact matches only)
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { validateOrigin, createTenantCorsHeaders, type CorsHeaders } from '../cors'

describe('CORS - Comprehensive Tests', () => {
  describe('validateOrigin', () => {
    describe('carousel-labs tenant', () => {
      const tenant = 'carousel-labs'

      it('should allow dev origin for carousel-labs', () => {
        const origin = 'https://carousel.dev.carousellabs.co'
        const result = validateOrigin(origin, tenant)
        expect(result).toBe(origin)
      })

      it('should allow prod origin for carousel-labs', () => {
        const origin = 'https://carousel.carousellabs.co'
        const result = validateOrigin(origin, tenant)
        expect(result).toBe(origin)
      })

      it('should reject unknown carousel-labs origin', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://malicious.carousellabs.co'
        const result = validateOrigin(origin, tenant)

        expect(result).toBeNull()
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CORS] Origin blocked - not in tenant allowlist'),
          expect.objectContaining({ origin, tenant })
        )

        consoleWarnSpy.mockRestore()
      })

      it('should reject subdomain attack for carousel-labs', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        // Attempt subdomain wildcard bypass
        const origin = 'https://evil.carousel.dev.carousellabs.co'
        const result = validateOrigin(origin, tenant)

        expect(result).toBeNull()
        expect(consoleWarnSpy).toHaveBeenCalled()

        consoleWarnSpy.mockRestore()
      })

      it('should reject HTTP (non-HTTPS) carousel-labs origin', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'http://carousel.dev.carousellabs.co' // HTTP instead of HTTPS
        const result = validateOrigin(origin, tenant)

        expect(result).toBeNull()

        consoleWarnSpy.mockRestore()
      })

      it('should reject port-based bypass for carousel-labs', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://carousel.dev.carousellabs.co:8080'
        const result = validateOrigin(origin, tenant)

        expect(result).toBeNull()

        consoleWarnSpy.mockRestore()
      })
    })

    describe('hringekjan tenant', () => {
      const tenant = 'hringekjan'

      it('should allow dev origin for hringekjan', () => {
        const origin = 'https://carousel.dev.hringekjan.is'
        const result = validateOrigin(origin, tenant)
        expect(result).toBe(origin)
      })

      it('should allow prod origin for hringekjan', () => {
        const origin = 'https://carousel.hringekjan.is'
        const result = validateOrigin(origin, tenant)
        expect(result).toBe(origin)
      })

      it('should reject carousel-labs origin for hringekjan tenant (tenant isolation)', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://carousel.dev.carousellabs.co'
        const result = validateOrigin(origin, tenant)

        expect(result).toBeNull()
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CORS] Origin blocked - not in tenant allowlist'),
          expect.objectContaining({ origin, tenant })
        )

        consoleWarnSpy.mockRestore()
      })

      it('should reject unknown hringekjan origin', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://malicious.hringekjan.is'
        const result = validateOrigin(origin, tenant)

        expect(result).toBeNull()

        consoleWarnSpy.mockRestore()
      })
    })

    describe('Unknown tenant', () => {
      it('should reject origin for unknown tenant', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://carousel.dev.carousellabs.co'
        const result = validateOrigin(origin, 'unknown-tenant')

        expect(result).toBeNull()
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CORS] Unknown tenant'),
          expect.objectContaining({ tenant: 'unknown-tenant' })
        )

        consoleWarnSpy.mockRestore()
      })

      it('should handle empty tenant', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://carousel.dev.carousellabs.co'
        const result = validateOrigin(origin, '')

        expect(result).toBeNull()
        expect(consoleWarnSpy).toHaveBeenCalled()

        consoleWarnSpy.mockRestore()
      })
    })

    describe('Missing or invalid origin', () => {
      it('should reject undefined origin', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const result = validateOrigin(undefined, 'carousel-labs')

        expect(result).toBeNull()
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CORS] No origin header provided')
        )

        consoleWarnSpy.mockRestore()
      })

      it('should reject empty string origin', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const result = validateOrigin('', 'carousel-labs')

        expect(result).toBeNull()

        consoleWarnSpy.mockRestore()
      })

      it('should reject malformed origin', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'not-a-url'
        const result = validateOrigin(origin, 'carousel-labs')

        expect(result).toBeNull()

        consoleWarnSpy.mockRestore()
      })
    })

    describe('Logging behavior', () => {
      it('should log when origin is allowed', () => {
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

        const origin = 'https://carousel.dev.carousellabs.co'
        validateOrigin(origin, 'carousel-labs')

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CORS] Origin allowed'),
          expect.objectContaining({ origin, tenant: 'carousel-labs' })
        )

        consoleLogSpy.mockRestore()
      })

      it('should include allowedOrigins in warning when blocked', () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

        const origin = 'https://evil.example.com'
        validateOrigin(origin, 'carousel-labs')

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[CORS] Origin blocked - not in tenant allowlist'),
          expect.objectContaining({
            origin,
            tenant: 'carousel-labs',
            allowedOrigins: expect.arrayContaining([
              'https://carousel.dev.carousellabs.co',
              'https://carousel.carousellabs.co',
            ]),
          })
        )

        consoleWarnSpy.mockRestore()
      })
    })
  })

  describe('createTenantCorsHeaders', () => {
    describe('Valid origin scenarios', () => {
      it('should create headers with allowed origin for carousel-labs', () => {
        const event = {
          headers: {
            origin: 'https://carousel.dev.carousellabs.co',
          },
        }

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe(
          'https://carousel.dev.carousellabs.co'
        )
        expect(headers['Access-Control-Allow-Methods']).toBe(
          'GET, POST, PUT, DELETE, OPTIONS'
        )
        expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type')
        expect(headers['Access-Control-Allow-Headers']).toContain('Authorization')
        expect(headers['Access-Control-Allow-Headers']).toContain('X-Tenant-Id')
        expect(headers['Access-Control-Allow-Headers']).toContain('X-CSRF-Token')
        expect(headers['Access-Control-Allow-Credentials']).toBe('true')
        expect(headers['Access-Control-Max-Age']).toBe('86400')
        expect(headers['Vary']).toBe('Origin')
      })

      it('should handle case-insensitive origin header (Origin vs origin)', () => {
        const event1 = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const event2 = { headers: { Origin: 'https://carousel.dev.carousellabs.co' } }

        const headers1 = createTenantCorsHeaders(event1, 'carousel-labs')
        const headers2 = createTenantCorsHeaders(event2, 'carousel-labs')

        expect(headers1['Access-Control-Allow-Origin']).toBe(
          'https://carousel.dev.carousellabs.co'
        )
        expect(headers2['Access-Control-Allow-Origin']).toBe(
          'https://carousel.dev.carousellabs.co'
        )
      })

      it('should prioritize lowercase origin header', () => {
        const event = {
          headers: {
            origin: 'https://carousel.dev.carousellabs.co',
            Origin: 'https://malicious.example.com',
          },
        }

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe(
          'https://carousel.dev.carousellabs.co'
        )
      })
    })

    describe('Invalid origin scenarios', () => {
      it('should return "null" for invalid origin (security best practice)', () => {
        const event = {
          headers: {
            origin: 'https://malicious.example.com',
          },
        }

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })

      it('should return "null" for missing origin', () => {
        const event = {
          headers: {},
        }

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })

      it('should return "null" for unknown tenant', () => {
        const event = {
          headers: {
            origin: 'https://carousel.dev.carousellabs.co',
          },
        }

        const headers = createTenantCorsHeaders(event, 'unknown-tenant')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })
    })

    describe('Required CORS headers', () => {
      it('should include all required CORS headers', () => {
        const event = {
          headers: {
            origin: 'https://carousel.dev.carousellabs.co',
          },
        }

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers).toHaveProperty('Access-Control-Allow-Origin')
        expect(headers).toHaveProperty('Access-Control-Allow-Methods')
        expect(headers).toHaveProperty('Access-Control-Allow-Headers')
        expect(headers).toHaveProperty('Access-Control-Allow-Credentials')
        expect(headers).toHaveProperty('Access-Control-Max-Age')
        expect(headers).toHaveProperty('Vary')
      })

      it('should allow all required HTTP methods', () => {
        const event = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        const methods = headers['Access-Control-Allow-Methods'].split(', ')
        expect(methods).toContain('GET')
        expect(methods).toContain('POST')
        expect(methods).toContain('PUT')
        expect(methods).toContain('DELETE')
        expect(methods).toContain('OPTIONS')
      })

      it('should allow all required headers including security headers', () => {
        const event = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        const allowedHeaders = headers['Access-Control-Allow-Headers']
        expect(allowedHeaders).toContain('Content-Type')
        expect(allowedHeaders).toContain('Authorization')
        expect(allowedHeaders).toContain('X-Tenant-Id')
        expect(allowedHeaders).toContain('X-CSRF-Token')
        expect(allowedHeaders).toContain('Cache-Control')
      })

      it('should enable credentials (required for auth)', () => {
        const event = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Credentials']).toBe('true')
      })

      it('should set 24-hour cache for preflight (86400 seconds)', () => {
        const event = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Max-Age']).toBe('86400')
      })

      it('should include Vary: Origin to prevent cache poisoning', () => {
        const event = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Vary']).toBe('Origin')
      })
    })

    describe('Multi-tenant isolation', () => {
      it('should isolate carousel-labs from hringekjan', () => {
        const event = {
          headers: {
            origin: 'https://carousel.dev.hringekjan.is',
          },
        }

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })

      it('should isolate hringekjan from carousel-labs', () => {
        const event = {
          headers: {
            origin: 'https://carousel.dev.carousellabs.co',
          },
        }

        const headers = createTenantCorsHeaders(event, 'hringekjan')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })

      it('should allow correct tenant origin mapping', () => {
        const event1 = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const event2 = { headers: { origin: 'https://carousel.dev.hringekjan.is' } }

        const headers1 = createTenantCorsHeaders(event1, 'carousel-labs')
        const headers2 = createTenantCorsHeaders(event2, 'hringekjan')

        expect(headers1['Access-Control-Allow-Origin']).toBe(
          'https://carousel.dev.carousellabs.co'
        )
        expect(headers2['Access-Control-Allow-Origin']).toBe(
          'https://carousel.dev.hringekjan.is'
        )
      })
    })

    describe('Security validation', () => {
      it('should NOT use wildcard (*) for Access-Control-Allow-Origin', () => {
        const event = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).not.toBe('*')
      })

      it('should use exact origin match (not regex or wildcard subdomains)', () => {
        const event = { headers: { origin: 'https://evil.carousel.dev.carousellabs.co' } }
        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        // Subdomain should be rejected (not allowed)
        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })

      it('should return consistent headers structure for all events', () => {
        const event1 = { headers: { origin: 'https://carousel.dev.carousellabs.co' } }
        const event2 = { headers: { origin: 'https://malicious.example.com' } }

        const headers1 = createTenantCorsHeaders(event1, 'carousel-labs')
        const headers2 = createTenantCorsHeaders(event2, 'carousel-labs')

        // Both should have same structure, just different origin value
        expect(Object.keys(headers1).sort()).toEqual(Object.keys(headers2).sort())
      })
    })

    describe('Edge cases', () => {
      it('should handle event with no headers object', () => {
        const event = {} as any

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })

      // Note: null events are not handled - Lambda always provides an event object

      it('should handle undefined headers', () => {
        const event = { headers: undefined } as any

        const headers = createTenantCorsHeaders(event, 'carousel-labs')

        expect(headers['Access-Control-Allow-Origin']).toBe('null')
      })
    })
  })
})
