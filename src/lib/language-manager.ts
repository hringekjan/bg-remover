// src/lib/language-manager.ts
import type { LanguageCode } from './types';

/**
 * Language Manager for dynamic multilingual support
 * Handles language code validation, mapping, and translation capabilities
 */

// Supported language definitions
export interface LanguageDefinition {
  code: LanguageCode;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  default: boolean;
}

export const SUPPORTED_LANGUAGES: LanguageDefinition[] = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    direction: 'ltr',
    default: true,
  },
  {
    code: 'is',
    name: 'Icelandic',
    nativeName: 'Íslenska',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'nl',
    name: 'Dutch',
    nativeName: 'Nederlands',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'sv',
    name: 'Swedish',
    nativeName: 'Svenska',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'da',
    name: 'Danish',
    nativeName: 'Dansk',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'no',
    name: 'Norwegian',
    nativeName: 'Norsk',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'fi',
    name: 'Finnish',
    nativeName: 'Suomi',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'pl',
    name: 'Polish',
    nativeName: 'Polski',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'ko',
    name: 'Korean',
    nativeName: '한국어',
    direction: 'ltr',
    default: false,
  },
  {
    code: 'zh',
    name: 'Chinese',
    nativeName: '中文',
    direction: 'ltr',
    default: false,
  },
];

/**
 * Language Manager class for handling multilingual operations
 */
export class LanguageManager {
  private static instance: LanguageManager;
  private languageCache = new Map<LanguageCode, LanguageDefinition>();
  private defaultLanguage: LanguageCode = 'en';

  private constructor() {
    // Initialize language cache
    SUPPORTED_LANGUAGES.forEach(lang => {
      this.languageCache.set(lang.code, lang);
      // Set default language
      if (lang.default) {
        this.defaultLanguage = lang.code;
      }
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): LanguageManager {
    if (!LanguageManager.instance) {
      LanguageManager.instance = new LanguageManager();
    }
    return LanguageManager.instance;
  }

  /**
   * Validate if a language code is supported
   */
  public isSupportedLanguage(languageCode: LanguageCode): boolean {
    return this.languageCache.has(languageCode);
  }

  /**
   * Get language definition by code
   */
  public getLanguageDefinition(languageCode: LanguageCode): LanguageDefinition | undefined {
    return this.languageCache.get(languageCode);
  }

  /**
   * Get all supported language codes
   */
  public getSupportedLanguageCodes(): LanguageCode[] {
    return Array.from(this.languageCache.keys());
  }

  /**
   * Get all supported languages
   */
  public getSupportedLanguages(): LanguageDefinition[] {
    return Array.from(this.languageCache.values());
  }

  /**
   * Get default language code
   */
  public getDefaultLanguage(): LanguageCode {
    return this.defaultLanguage;
  }

  /**
   * Normalize language code (e.g., 'en-US' -> 'en', 'pt-BR' -> 'pt')
   */
  public normalizeLanguageCode(languageCode: LanguageCode): LanguageCode {
    const baseCode = languageCode.split('-')[0];
    if (this.isSupportedLanguage(baseCode)) {
      return baseCode;
    }
    return this.defaultLanguage;
  }

  /**
   * Validate and normalize a list of language codes
   */
  public validateLanguageList(languageCodes: LanguageCode[]): LanguageCode[] {
    const normalizedCodes = languageCodes.map(code => this.normalizeLanguageCode(code));
    const uniqueCodes = Array.from(new Set(normalizedCodes));
    
    // Ensure at least one language is included
    if (uniqueCodes.length === 0) {
      uniqueCodes.push(this.defaultLanguage);
    }
    
    return uniqueCodes;
  }

  /**
   * Get language fallback chain
   */
  public getLanguageFallbackChain(languageCode: LanguageCode): LanguageCode[] {
    const chain: LanguageCode[] = [languageCode];
    
    // Add base language if it's a variant (e.g., en-US -> en)
    const baseCode = this.normalizeLanguageCode(languageCode);
    if (baseCode !== languageCode) {
      chain.unshift(baseCode);
    }
    
    // Always end with default language
    if (baseCode !== this.defaultLanguage) {
      chain.push(this.defaultLanguage);
    }
    
    return chain;
  }

  /**
   * Check if language supports right-to-left text
   */
  public isRightToLeft(languageCode: LanguageCode): boolean {
    const lang = this.getLanguageDefinition(this.normalizeLanguageCode(languageCode));
    return lang?.direction === 'rtl';
  }

  /**
   * Get language display name
   */
  public getLanguageDisplayName(languageCode: LanguageCode, useNativeName = false): string {
    const lang = this.getLanguageDefinition(this.normalizeLanguageCode(languageCode));
    if (!lang) {
      return languageCode;
    }
    return useNativeName ? lang.nativeName : lang.name;
  }

  /**
   * Auto-detect language from user preferences or headers
   */
  public autoDetectLanguage(preferredLanguages?: string[]): LanguageCode {
    if (preferredLanguages && preferredLanguages.length > 0) {
      for (const lang of preferredLanguages) {
        const normalized = this.normalizeLanguageCode(lang as LanguageCode);
        if (this.isSupportedLanguage(normalized)) {
          return normalized;
        }
      }
    }
    
    return this.defaultLanguage;
  }

  /**
   * Create language query for API requests
   */
  public createLanguageQuery(languageCodes: LanguageCode[]): string {
    const validCodes = this.validateLanguageList(languageCodes);
    return validCodes.join(',');
  }

  /**
   * Parse Accept-Language header
   */
  public parseAcceptLanguage(header: string): LanguageCode[] {
    if (!header) return [this.defaultLanguage];
    
    const languages = header
      .split(',')
      .map(lang => lang.trim().split(';')[0].trim())
      .filter(lang => lang.length > 0)
      .map(lang => this.normalizeLanguageCode(lang as LanguageCode))
      .filter(lang => this.isSupportedLanguage(lang));
    
    return languages.length > 0 ? languages : [this.defaultLanguage];
  }
}

// Export singleton instance
export const languageManager = LanguageManager.getInstance();

// Utility functions
export const isValidLanguageCode = (code: string): code is LanguageCode => {
  return languageManager.isSupportedLanguage(code as LanguageCode);
};

export const normalizeLanguageCode = (code: LanguageCode): LanguageCode => {
  return languageManager.normalizeLanguageCode(code);
};

export const getSupportedLanguages = (): LanguageDefinition[] => {
  return languageManager.getSupportedLanguages();
};

export const getDefaultLanguage = (): LanguageCode => {
  return languageManager.getDefaultLanguage();
};

export const validateLanguageList = (codes: LanguageCode[]): LanguageCode[] => {
  return languageManager.validateLanguageList(codes);
};