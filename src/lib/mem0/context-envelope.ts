/**
 * Context Envelope for BG-Remover Service
 * 
 * This file defines the structure for context envelope used in mem0 integration.
 */

export interface ContextEnvelope {
  pricingType?: string;
  tenant?: string;
  // Add other context envelope properties as needed
}