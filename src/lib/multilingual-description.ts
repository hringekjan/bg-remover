// src/lib/multilingual-description.ts
import type { 
  LanguageCode, 
  ProductDescription, 
  MultilingualProductDescription,
  ProductCondition,
  PriceSuggestion,
  RatingSuggestion 
} from './types';
import { languageManager } from './language-manager';
import { suggestionEngine } from './suggestion-engine';

/**
 * Multilingual Description Generator
 * Generates product descriptions in multiple languages with AI assistance
 */

interface ProductFeatures {
  name: string;
  category: string;
  colors?: string[];
  condition: ProductCondition;
  brand?: string;
  material?: string;
  style?: string;
  size?: string;
  age?: string;
  occasion?: string;
  features?: string[];
  // NEW: Group-aware context fields
  groupContext?: string; // Rich context from group metadata
  imageCount?: number; // Total images in group
  hasMultipleAngles?: boolean; // Whether product has multiple views
}

interface DescriptionTemplates {
  [language: string]: {
    short: {
      [condition in ProductCondition]: string;
    };
    long: {
      [condition in ProductCondition]: string;
    };
    keywords: {
      [category: string]: string[];
    };
  };
}

// Template library for different languages and product types
const DESCRIPTION_TEMPLATES: DescriptionTemplates = {
  en: {
    short: {
      new_with_tags: "Brand new {{name}} in excellent condition. Perfect for {{occasion}}.",
      like_new: "Beautiful {{name}} in like-new condition. Barely used and well-maintained.",
      very_good: "Lovely {{name}} in very good condition with minimal signs of wear.",
      good: "Nice {{name}} in good condition with some signs of use but still great value.",
      fair: "Decent {{name}} in fair condition. Shows wear but functional and affordable."
    },
    long: {
      new_with_tags: "This {{name}} is brand new with tags attached, representing exceptional quality and craftsmanship. Perfect for {{occasion}} or as a thoughtful gift. Made from premium {{material}} and designed with attention to detail, this item offers both style and durability. The {{condition}} condition ensures you're getting a product that meets the highest standards.",
      like_new: "This beautiful {{name}} is in like-new condition, having been used only a few times and meticulously cared for. It shows virtually no signs of wear and maintains its original quality and appearance. Perfect for {{occasion}}, this item offers the experience of owning something new at a more accessible price point. Crafted from quality {{material}}, it combines functionality with aesthetic appeal.",
      very_good: "This lovely {{name}} is in very good condition with only minimal signs of use. While it may show some light wear from normal handling, it remains structurally sound and visually appealing. Ideal for {{occasion}}, this piece offers excellent value for money without compromising on quality. The craftsmanship is evident in the {{material}} construction and thoughtful design details.",
      good: "This nice {{name}} is in good condition and has been well-maintained throughout its life. It shows some signs of use consistent with regular wear, but these do not detract from its overall functionality and appeal. Perfect for {{occasion}} or everyday use, this item represents a practical choice that doesn't sacrifice style. The {{material}} material ensures durability while the design remains timeless.",
      fair: "This {{name}} is in fair condition and shows visible signs of wear from regular use. While it may have some imperfections, it remains functional and offers an affordable option for those seeking value. Despite the wear, it still retains its basic functionality and can serve well for {{occasion}}. This item represents an economical choice without compromising on basic quality standards."
    },
    keywords: {
      clothing: ["fashion", "style", "wear", "apparel", "outfit", "garment", "textile", "fabric"],
      electronics: ["technology", "device", "gadget", "electronic", "digital", "modern", "innovative", "smart"],
      furniture: ["furniture", "home", "decor", "interior", "comfort", "functional", "design", "style"],
      jewelry: ["jewelry", "accessory", "elegant", "luxury", "precious", "beautiful", "timeless", "classic"],
      art: ["artwork", "artistic", "creative", "unique", "original", "beautiful", "inspiring", "decorative"],
      collectibles: ["collectible", "rare", "vintage", "limited", "special", "unique", "valuable", "sought-after"],
      vintage: ["vintage", "classic", "retro", "timeless", "authentic", "nostalgic", "traditional", "historical"],
      handmade: ["handmade", "artisan", "crafted", "unique", "personal", "custom", "artistic", "one-of-a-kind"],
      sports: ["sports", "athletic", "fitness", "active", "performance", "training", "exercise", "recreational"],
      home: ["home", "household", "domestic", "practical", "useful", "functional", "everyday", "essential"]
    }
  },
  is: {
    short: {
      new_with_tags: "Nýtt {{name}} í frábæru ástandi. Tilvalið fyrir {{occasion}}.",
      like_new: "Fallegt {{name}} í næstum nýu ástandi. Lítið notað og vel viðhaldið.",
      very_good: "Mjög fallegt {{name}} í mjög góðu ástandi með litlum notkunarsporsum.",
      good: "Gott {{name}} í góðu ástandi með nokkrum notkunarsporsum en samt góð verðmæti.",
      fair: "Sanngjarnt {{name}} í sanngjörnu ástandi. Sýnir slit en virkar og er hagkvæmt."
    },
    long: {
      new_with_tags: "Þetta {{name}} er nýtt með merkjum, sem táknar einstök gæði og handverk. Tilvalið fyrir {{occasion}} eða sem hugsi gjöf. Gert úr hágæða {{material}} og hannað með athygli á smáatriðum, þessi hlutur býður bæði stíl og endingargirni. {{condition}} ástandið tryggir að þú fáir vöru sem uppfyllir hæsta staðal.",
      like_new: "Þetta fallega {{name}} er í næstum nýu ástandi, hefur verið notað aðeins nokkrum sinnum og vandlega viðhaldið. Það sýnir svo að segja engin notkunarspor og heldur upprunalegu gæðum og útliti. Tilvalið fyrir {{occasion}}, þessi hlutur býður reynslu af því að eiga eitthvað nýtt á aðgengilegra verði. Gert úr góðu {{material}}, það sameinar virkni með fegurð.",
      very_good: "Þetta mjög fallega {{name}} er í mjög góðu ástandi með aðeins ljósum notkunarsporsum. Þó það sýni mögulega lítil slit frá eðlilegri meðhöndlun, þá er það enn stöðugt og útlit er aðlaðandi. Tilvalið fyrir {{occasion}}, þetta stykki býður frábært verðmæti fyrir peninga án þess að fórna gæðum. Handverkið er augljóst í {{material}} smíðinni og hugsuðu hönnunaratriðum.",
      good: "Þetta góða {{name}} er í góðu ástandi og hefur verið vel viðhaldað alla ævi sína. Það sýnir nokkurn notkunarspor sem eru í samræmi við venjulegt slit, en þau draga ekki frá heildarvirkni og aðdráttarafl. Tilvalið fyrir {{occasion}} eða daglega notkun, þessi hlutur táknar praktíska valkost sem þarf ekki að fórna stíl. {{material}} efnið tryggir endingargirni á meðan hönnunin er tímalaus.",
      fair: "Þetta {{name}} er í sanngjörnu ástandi og sýnir augljós notkunarspor frá venjulegri notkun. Þó það kunni að hafa nokkura ófullkomleika, þá virkar það samt og býður hagkvæman valkost fyrir þá sem leita verðmæta. Þrátt fyrir slit, þá heldur það enn grunnvirkni sinni og getur þjónað vel fyrir {{occasion}}. Þessi hlutur táknar hagkvæman valkost án þess að fórna grunn gæðum."
    },
    keywords: {
      clothing: ["tíska", "stíl", "fatnaður", "föt", "útlitsbúningur", "föt", "textíll", "efni"],
      electronics: ["tækni", "tæki", "göddur", "rafrænt", "stafrænt", "nútímalegt", "nýstárlegt", "snjallt"],
      furniture: ["húsgögn", "heimili", "skrautmuni", "innri", "þægindi", "virkni", "hönnun", "stíl"],
      jewelry: ["skart", "aukahlutur", "elegant", "luksus", "dýr", "fallegur", "timani", "klassískur"],
      art: ["listaverk", "listrænn", "skapandi", "einstakur", "upprunalegur", "fallegur", "innblástur", "skraut"],
      collectibles: ["safnhlutur", "sjaldgæfur", "vintage", "takmarkaður", "sérstakur", "einstakur", "verðmætur", "eftirsóttur"],
      vintage: ["vintage", "klassískur", "retro", "timani", "réttur", "minningarík", "hefðbundinn", "sögulegur"],
      handmade: ["handgert", "handverksmaður", "smíðaður", "einstakur", "persónulegur", "sérsniðinn", "listrænn", "einn í sínum flokki"],
      sports: ["íþróttir", "íþróttalegur", "líkamsrækt", "virkur", "árangur", "þjálfun", "æfing", "skemmtilegur"],
      home: ["heimili", "heimilis", "innanhúss", "praktískur", "nytsamur", "virkni", "daglegur", " nauðsynlegur"]
    }
  },
  de: {
    short: {
      new_with_tags: "Brandneue {{name}} in ausgezeichnetem Zustand. Perfekt für {{occasion}}.",
      like_new: "Schöne {{name}} in neuwertigem Zustand. Kaum verwendet und gut gepflegt.",
      very_good: "Wunderschöne {{name}} in sehr gutem Zustand mit minimalen Gebrauchsspuren.",
      good: "Schöne {{name}} in gutem Zustand mit einigen Gebrauchsspuren aber immer noch gutes Preis-Leistungs-Verhältnis.",
      fair: "Anständige {{name}} in ordentlichem Zustand. Zeigt Gebrauchsspuren aber funktional und erschwinglich."
    },
    long: {
      new_with_tags: "Diese {{name}} ist brandneu mit angehängten Etiketten und stellt außergewöhnliche Qualität und Handwerkskunst dar. Perfekt für {{occasion}} oder als durchdachtes Geschenk. Hergestellt aus hochwertigem {{material}} und mit Liebe zum Detail entworfen, bietet dieser Artikel sowohl Stil als auch Haltbarkeit.",
      like_new: "Diese schöne {{name}} ist in neuwertigem Zustand, wurde nur wenige Male verwendet und sorgfältig gepflegt. Sie zeigt praktisch keine Gebrauchsspuren und behält ihre ursprüngliche Qualität und ihr Aussehen bei. Perfekt für {{occasion}}, bietet dieser Artikel die Erfahrung, etwas Neues zu besitzen zu einem zugänglicheren Preis.",
      very_good: "Diese wunderschöne {{name}} ist in sehr gutem Zustand mit nur minimalen Gebrauchsspuren. Während sie möglicherweise leichte Abnutzungserscheinungen vom normalen Gebrauch zeigt, bleibt sie strukturell solide und visuell ansprechend. Ideal für {{occasion}}, bietet dieses Stück ein ausgezeichnetes Preis-Leistungs-Verhältnis ohne Kompromisse bei der Qualität.",
      good: "Diese schöne {{name}} ist in gutem Zustand und wurde während ihres Lebens gut gepflegt. Sie zeigt einige Gebrauchsspuren, die mit normalem Verschleiß einhergehen, aber diese beeinträchtigen nicht ihre allgemeine Funktionalität und Attraktivität. Perfekt für {{occasion}} oder den täglichen Gebrauch, stellt dieser Artikel eine praktische Wahl dar, die nicht auf Stil verzichtet.",
      fair: "Diese {{name}} ist in ordentlichem Zustand und zeigt sichtbare Gebrauchsspuren vom normalen Gebrauch. Während sie einige Unvollkommenheiten haben kann, bleibt sie funktional und bietet eine erschwingliche Option für diejenigen, die Wert suchen. Trotz der Abnutzung behält sie ihre Grundfunktionalität und kann gut für {{occasion}} dienen."
    },
    keywords: {
      clothing: ["Mode", "Stil", "Kleidung", "Bekleidung", "Outfit", "Kleidungsstück", "Textil", "Stoff"],
      electronics: ["Technologie", "Gerät", "Gadget", "Elektronik", "Digital", "Modern", "Innovativ", "Smart"],
      furniture: ["Möbel", "Zuhause", "Deko", "Innenraum", "Komfort", "Funktional", "Design", "Stil"],
      jewelry: ["Schmuck", "Accessoire", "Elegant", "Luxus", "Wertvoll", "Schön", "Zeitlos", "Klassisch"],
      art: ["Kunstwerk", "Künstlerisch", "Kreativ", "Einzigartig", "Original", "Schön", "Inspirierend", "Dekorativ"],
      collectibles: ["Sammlerstück", "Selten", "Vintage", "Limitiert", "Speziell", "Einzigartig", "Wertvoll", "Begehrt"],
      vintage: ["Vintage", "Klassisch", "Retro", "Zeitlos", "Authentisch", "Nostalgisch", "Traditionell", "Historisch"],
      handmade: ["Handgemacht", "Handwerker", "Gefertigt", "Einzigartig", "Persönlich", "Maßgeschneidert", "Künstlerisch", "Einzigartig"],
      sports: ["Sport", "Athletisch", "Fitness", "Aktiv", "Leistung", "Training", "Übung", "Freizeit"],
      home: ["Zuhause", "Haushalt", "Haushalts", "Praktisch", "Nützlich", "Funktional", "Täglich", "Essentiell"]
    }
  }
  // Additional languages can be added following the same pattern
};

/**
 * Multilingual Description Generator class
 */
export class MultilingualDescriptionGenerator {
  private static instance: MultilingualDescriptionGenerator;

  private constructor() {}

  public static getInstance(): MultilingualDescriptionGenerator {
    if (!MultilingualDescriptionGenerator.instance) {
      MultilingualDescriptionGenerator.instance = new MultilingualDescriptionGenerator();
    }
    return MultilingualDescriptionGenerator.instance;
  }

  /**
   * Generate multilingual product descriptions
   */
  public async generateMultilingualDescriptions(
    productFeatures: ProductFeatures,
    languages: LanguageCode[] = ['en', 'is'],
    includePriceSuggestion = false,
    includeRatingSuggestion = false
  ): Promise<MultilingualProductDescription> {
    const validLanguages = languageManager.validateLanguageList(languages);
    const descriptions: MultilingualProductDescription = {};

    // Generate descriptions for each requested language
    for (const language of validLanguages) {
      descriptions[language] = this.generateSingleDescription(
        productFeatures,
        language,
        includePriceSuggestion,
        includeRatingSuggestion
      );
    }

    return descriptions;
  }

  /**
   * Generate description for a single language
   */
  private generateSingleDescription(
    productFeatures: ProductFeatures,
    language: LanguageCode,
    includePriceSuggestion: boolean,
    includeRatingSuggestion: boolean
  ): ProductDescription {
    const templates = this.getTemplates(language);
    const category = this.normalizeCategory(productFeatures.category);
    
    // Generate short description
    const shortDescription = this.generateShortDescription(productFeatures, templates, language);
    
    // Generate long description
    const longDescription = this.generateLongDescription(productFeatures, templates, language);
    
    // Generate keywords from template AND from description text
    const templateKeywords = this.generateKeywords(productFeatures, templates, category);
    const descriptionKeywords = this.extractKeywordsFromText(longDescription);
    const allKeywords = [...new Set([...templateKeywords, ...descriptionKeywords])].slice(0, 20);
    
    // Generate suggestions if requested
    let priceSuggestion: PriceSuggestion | undefined;
    let ratingSuggestion: RatingSuggestion | undefined;
    
    if (includePriceSuggestion || includeRatingSuggestion) {
      const featuresForSuggestion = {
        category: productFeatures.category,
        brand: productFeatures.brand,
        material: productFeatures.material,
        craftsmanship: productFeatures.style,
        age: productFeatures.age,
        condition: productFeatures.condition || 'good',
        colors: productFeatures.colors,
        size: productFeatures.size,
        occasion: productFeatures.occasion,
      };

      if (includePriceSuggestion) {
        priceSuggestion = suggestionEngine.generatePriceSuggestion(featuresForSuggestion, language);
      }

      if (includeRatingSuggestion) {
        ratingSuggestion = suggestionEngine.generateRatingSuggestion(featuresForSuggestion, language);
      }
    }

    return {
      short: shortDescription,
      long: longDescription,
      keywords: allKeywords,
      category: productFeatures.category,
      colors: productFeatures.colors,
      condition: productFeatures.condition || 'good',
      priceSuggestion,
      ratingSuggestion,
    };
  }

  /**
   * Generate short description
   */
  private generateShortDescription(
    productFeatures: ProductFeatures,
    templates: any,
    language: LanguageCode
  ): string {
    const condition = productFeatures.condition || 'good';
    const template = templates.short[condition] || templates.short.good;
    
    return this.replaceTemplateVariables(template, productFeatures, language);
  }

  /**
   * Generate long description
   */
  private generateLongDescription(
    productFeatures: ProductFeatures,
    templates: any,
    language: LanguageCode
  ): string {
    const condition = productFeatures.condition || 'good';
    let template = templates.long[condition] || templates.long.good;

    let description = this.replaceTemplateVariables(template, productFeatures, language);

    // Enhance with group context if available
    if (productFeatures.groupContext) {
      const contextEnhancement = this.getContextEnhancement(language, productFeatures);
      description = `${description} ${contextEnhancement}`;
    }

    // Add multiple angles mention if applicable
    if (productFeatures.hasMultipleAngles && productFeatures.imageCount) {
      const anglesText = this.getMultipleAnglesText(language, productFeatures.imageCount);
      description = `${description} ${anglesText}`;
    }

    return description;
  }

  /**
   * Get context enhancement text based on group metadata
   */
  private getContextEnhancement(language: LanguageCode, features: ProductFeatures): string {
    if (!features.groupContext) return '';

    const isProfessional = features.groupContext.includes('Professional photography');
    const isStudio = features.groupContext.includes('Studio background');

    const enhancements: Record<LanguageCode, string> = {
      en: isProfessional
        ? 'This listing features professional photography showcasing the product from multiple angles.'
        : isStudio
        ? 'High-quality images captured in professional studio conditions.'
        : 'Detailed photography showing all aspects of the product.',
      is: isProfessional
        ? 'Þessi skráning inniheldur faglegar ljósmyndir sem sýna vöruna frá mörgum hliðum.'
        : isStudio
        ? 'Hágæða myndir teknar í faglegum stúdíóaðstæðum.'
        : 'Ítarlegar myndir sem sýna alla þætti vörunnar.',
      de: isProfessional
        ? 'Dieses Angebot zeigt professionelle Fotografie aus mehreren Blickwinkeln.'
        : isStudio
        ? 'Hochwertige Bilder in professionellen Studiobedingungen aufgenommen.'
        : 'Detaillierte Fotografie, die alle Aspekte des Produkts zeigt.',
    };

    return enhancements[language] || enhancements.en;
  }

  /**
   * Get text describing multiple angles
   */
  private getMultipleAnglesText(language: LanguageCode, imageCount: number): string {
    const texts: Record<LanguageCode, string> = {
      en: `Includes ${imageCount} detailed images showing front, side, back, and detail views.`,
      is: `Inniheldur ${imageCount} ítarlegar myndir sem sýna fram-, hliðar-, bak- og smáatriði.`,
      de: `Enthält ${imageCount} detaillierte Bilder mit Vorder-, Seiten-, Rück- und Detailansichten.`,
    };

    return texts[language] || texts.en;
  }

  /**
   * Generate keywords
   */
  private generateKeywords(
    productFeatures: ProductFeatures,
    templates: any,
    category: string
  ): string[] {
    const baseKeywords = templates.keywords[category] || [];
    const customKeywords: string[] = [];

    // Add product-specific keywords
    if (productFeatures.brand) {
      customKeywords.push(productFeatures.brand.toLowerCase());
    }
    
    if (productFeatures.material) {
      customKeywords.push(productFeatures.material.toLowerCase());
    }
    
    if (productFeatures.style) {
      customKeywords.push(productFeatures.style.toLowerCase());
    }
    
    if (productFeatures.colors) {
      customKeywords.push(...productFeatures.colors.map(color => color.toLowerCase()));
    }

    // Add condition keywords
    const conditionKeywords: Record<ProductCondition, string[]> = {
      'new_with_tags': ['new', 'brand new', 'unused'],
      'like_new': ['like new', 'excellent', 'premium'],
      'very_good': ['very good', 'well maintained', 'quality'],
      'good': ['good condition', 'functional', 'reliable'],
      'fair': ['affordable', 'budget', 'value'],
    };

    customKeywords.push(...(conditionKeywords[productFeatures.condition || 'good'] || []));

    // Combine and deduplicate keywords
    const allKeywords = [...baseKeywords, ...customKeywords];
    return Array.from(new Set(allKeywords)).slice(0, 15); // Limit to 15 keywords
  }

  /**
   * Replace template variables with actual values
   */
  private replaceTemplateVariables(
    template: string,
    productFeatures: ProductFeatures,
    language: LanguageCode
  ): string {
    let result = template;

    // Replace {{name}} with product name
    result = result.replace(/\{\{name\}\}/g, productFeatures.name);

    // Replace {{material}} with material or fallback
    const material = productFeatures.material || this.getMaterialFallback(language);
    result = result.replace(/\{\{material\}\}/g, material);

    // Replace {{condition}} with condition description
    const conditionDesc = this.getConditionDescription(productFeatures.condition || 'good', language);
    result = result.replace(/\{\{condition\}\}/g, conditionDesc);

    // Replace {{occasion}} with occasion or fallback
    const occasion = productFeatures.occasion || this.getOccasionFallback(language);
    result = result.replace(/\{\{occasion\}\}/g, occasion);

    return result;
  }

  /**
   * Get templates for a specific language
   */
  private getTemplates(language: LanguageCode): any {
    const normalizedLang = languageManager.normalizeLanguageCode(language);
    return DESCRIPTION_TEMPLATES[normalizedLang] || DESCRIPTION_TEMPLATES.en;
  }

  /**
   * Normalize category name
   */
  private normalizeCategory(category: string): string {
    const categoryMap: Record<string, string> = {
      'apparel': 'clothing',
      'clothes': 'clothing',
      'fashion': 'clothing',
      'garments': 'clothing',
      'tech': 'electronics',
      'gadgets': 'electronics',
      'devices': 'electronics',
      'home_decor': 'home',
      'decor': 'home',
      'accessories': 'jewelry',
      'fine_jewelry': 'jewelry',
      'watches': 'jewelry',
      'paintings': 'art',
      'sculptures': 'art',
      'photography': 'art',
      'antiques': 'vintage',
      'collectible': 'collectibles',
      'collectibles': 'collectibles',
      'handcrafted': 'handmade',
      'custom': 'handmade',
      'sporting': 'sports',
      'fitness': 'sports',
      'exercise': 'sports',
    };

    const normalized = category.toLowerCase().replace(/[^a-z_]/g, '');
    return categoryMap[normalized] || normalized || 'home';
  }

  /**
   * Get material fallback for language
   */
  private getMaterialFallback(language: LanguageCode): string {
    const fallbacks: Record<LanguageCode, string> = {
      'en': 'quality materials',
      'is': 'góðu efni',
      'de': 'hochwertige Materialien',
      'fr': 'matériaux de qualité',
      'es': 'materiales de calidad',
      // Add more languages as needed
    };

    return fallbacks[language] || fallbacks['en'];
  }

  /**
   * Get condition description in specific language
   */
  private getConditionDescription(condition: ProductCondition, language: LanguageCode): string {
    const descriptions: Record<LanguageCode, Record<ProductCondition, string>> = {
      en: {
        'new_with_tags': 'new with tags',
        'like_new': 'like-new',
        'very_good': 'very good',
        'good': 'good',
        'fair': 'fair',
      },
      is: {
        'new_with_tags': 'nýtt með merkjum',
        'like_new': 'næstum nýtt',
        'very_good': 'mjög gott',
        'good': 'gott',
        'fair': 'sanngjarnt',
      },
      de: {
        'new_with_tags': 'neu mit Etiketten',
        'like_new': 'neuwertig',
        'very_good': 'sehr gut',
        'good': 'gut',
        'fair': 'ordentlich',
      },
      // Add more languages as needed
    };

    const langDescriptions = descriptions[language] || descriptions.en;
    return langDescriptions[condition] || langDescriptions.good;
  }

  /**
   * Get occasion fallback for language
   */
  private getOccasionFallback(language: LanguageCode): string {
    const fallbacks: Record<LanguageCode, string> = {
      'en': 'everyday use',
      'is': 'daglega notkun',
      'de': 'täglichen Gebrauch',
      'fr': 'usage quotidien',
      'es': 'uso diario',
      // Add more languages as needed
    };

    return fallbacks[language] || fallbacks['en'];
  }

  /**
   * Enhance existing description with additional languages
   */
  public async enhanceDescription(
    existingDescription: ProductDescription,
    newLanguages: LanguageCode[],
    includePriceSuggestion = false,
    includeRatingSuggestion = false
  ): Promise<MultilingualProductDescription> {
    const enhanced: MultilingualProductDescription = {};

    // Use existing description as base for English if not present
    if (!enhanced.en) {
      enhanced.en = { ...existingDescription };
    }

    // Generate descriptions for new languages
    for (const language of newLanguages) {
      if (language === 'en' && enhanced.en) continue; // Skip if English already exists

      const productFeatures: ProductFeatures = {
        name: 'Product', // This would need to be extracted or provided
        category: existingDescription.category || 'general',
        colors: existingDescription.colors,
        condition: existingDescription.condition || 'good',
        brand: existingDescription.priceSuggestion?.factors.brand,
        material: this.extractMaterialFromDescription(existingDescription.long),
        style: this.extractStyleFromDescription(existingDescription.long),
      };

      enhanced[language] = this.generateSingleDescription(
        productFeatures,
        language,
        includePriceSuggestion,
        includeRatingSuggestion
      );
    }

    return enhanced;
  }

  /**
   * Extract keywords from description text
   */
  private extractKeywordsFromText(text: string): string[] {
    // Common English and Icelandic stop words to filter out
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'this', 'that', 'these',
      'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you',
      'your', 'he', 'she', 'his', 'her', 'who', 'which', 'what', 'when', 'where',
      'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
      'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
      'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then', 'once',
      'þetta', 'þessu', 'þessar', 'þessara', 'og', 'eða', 'en', 'í', 'á', 'af',
      'með', 'fyrir', 'um', 'er', 'var', 'vera', 'hefur', 'hafa', 'varð', 'verið',
      'þetta', 'þessi', 'sá', 'þeir', 'þær', 'það', 'sem'
    ]);

    // Extract words from text
    const words = text
      .toLowerCase()
      .replace(/[^a-záðéýúíóþæöðø\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    return [...new Set(words)];
  }

  /**
   * Extract material from description text
   */
  private extractMaterialFromDescription(description: string): string | undefined {
    const materials = ['cotton', 'leather', 'silk', 'wool', 'polyester', 'denim', 'linen', 'cashmere'];
    const lowerDesc = description.toLowerCase();
    
    for (const material of materials) {
      if (lowerDesc.includes(material)) {
        return material;
      }
    }
    
    return undefined;
  }

  /**
   * Extract style from description text
   */
  private extractStyleFromDescription(description: string): string | undefined {
    const styles = ['casual', 'formal', 'vintage', 'modern', 'classic', 'contemporary', 'minimalist'];
    const lowerDesc = description.toLowerCase();
    
    for (const style of styles) {
      if (lowerDesc.includes(style)) {
        return style;
      }
    }
    
    return undefined;
  }
}

// Export singleton instance
export const multilingualDescriptionGenerator = MultilingualDescriptionGenerator.getInstance();