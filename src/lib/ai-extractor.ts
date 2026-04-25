// src/lib/ai-extractor.ts
/**
 * AI Attribute Extractor
 *
 * Extracts structured product attributes from AI-generated descriptions
 * Two modes:
 * 1. AI-Native Extraction (USE_AI_EXTRACTION=true) - Uses Mistral Pixtral results directly
 * 2. Regex-Based Extraction (default) - Lightweight regex patterns for backward compatibility
 *
 * All new fields are optional for backwards compatibility.
 */

import type { MultilingualProductDescription, ProductDescription } from './types';
import type { MistralPixtralAnalysisResult } from './bedrock/mistral-pixtral-analyzer';

// Feature flag: Enable AI-native extraction (default: false for gradual rollout)
const USE_AI_EXTRACTION = process.env.USE_AI_EXTRACTION === 'true';

// Known brand list for direct matching (mutable so registry brands can be added at cold start)
const KNOWN_BRANDS = new Set([
  'abercrombie', 'adidas', 'armani', 'balenciaga', 'burberry', 'calvin klein',
  'cartier', 'chanel', 'coach', 'dior', 'dolce & gabbana', 'fendi', 'gap',
  'gucci', 'h&m', 'hermès', 'hugo boss', 'lacoste', 'levi', "levi's", 'levis',
  'louis vuitton', 'mango', 'michael kors', 'nike', 'prada', 'puma',
  'ralph lauren', 'rolex', 'tiffany', 'tommy hilfiger', 'uniqlo', 'versace',
  'zara', '&otherstories', 'cos', 'massimo dutti', 'pull & bear', 'bershka',
  'stradivarius',
  // Denim & casualwear
  'wrangler', 'lee', 'diesel', 'g-star', 'g-star raw', 'nudie jeans',
  'acne studios', 'weekday', 'dr. denim', 'scotch & soda',
  // Sportswear
  'reebok', 'under armour', 'new balance', 'asics', 'converse', 'vans',
  'timberland', 'columbia', 'the north face', 'patagonia', 'fjallraven',
  'salomon', 'arc\'teryx',
  // Mid-market
  'moncler', 'stone island', 'barbour', 'hackett', 'gant', 'superdry',
  'hollister', 'jack & jones', 'selected', 'only', 'vero moda', 'vila',
  'pieces', 'noisy may', 'object', 'free people', 'anthropologie',
  // Luxury
  'saint laurent', 'givenchy', 'celine', 'loewe', 'bottega veneta',
  'alexander mcqueen', 'valentino', 'moschino', 'off-white', 'acne',
]);

// Material keywords
const MATERIAL_PATTERNS = /\b(cotton|linen|polyester|leather|silk|wool|cashmere|denim|suede|velvet|satin|chiffon|nylon|spandex|elastane|viscose|rayon|acrylic|fleece|corduroy|tweed|knit|jersey)\b/gi;

// Color keywords (single and multi-word)
const COLOR_PATTERNS = /\b(light|dark|pale|bright|deep)?\s?(gray|grey|white|black|blue|red|green|yellow|purple|brown|beige|navy|maroon|olive|teal|pink|orange|cream|tan|khaki|burgundy|charcoal|ivory|gold|silver|bronze|copper|turquoise|lavender|mint|coral|peach|rose|crimson|indigo|violet|magenta|cyan|lime|rust|mustard|emerald|sapphire|ruby)\b/gi;

// Pattern keywords
const PATTERN_KEYWORDS = /\b(striped?|solid|floral|polka dot|checkered|plaid|geometric|paisley|animal print|zebra|leopard|houndstooth|argyle|chevron|abstract|tie-dye|camouflage)\b/gi;

// Style adjectives
const STYLE_ADJECTIVES = /\b(casual|formal|elegant|sporty|relaxed|fitted|oversized|slim|classic|modern|vintage|bohemian|minimalist|preppy|edgy|sophisticated|chic|trendy|business|athletic)\b/gi;

// Seasonal keywords
const SEASONAL_KEYWORDS = /\b(summer|winter|spring|fall|autumn|all-season)\b/gi;

// Sustainability keywords
const SUSTAINABILITY_KEYWORDS = /\b(sustainable|eco-friendly|organic|recycled|fair trade|ethically sourced|biodegradable|renewable|vegan|cruelty-free)\b/gi;

// Care instruction keywords
const CARE_INSTRUCTION_PATTERNS = /\b(machine wash cold|machine wash warm|hand wash only|dry clean only|do not dry clean|tumble dry low|tumble dry medium|do not tumble dry|line dry|lay flat to dry|hang to dry|iron on low heat|iron on medium heat|do not iron|steam only|cool iron if needed|do not bleach|non-chlorine bleach only|bleach when needed|professional dry clean|dry flat|reshape while damp)\b/gi;

// Condition rating keywords (1-5 scale)
const CONDITION_EXCELLENT = /\b(new with tags|brand new|never worn|mint condition|pristine|unworn|nwt|bnwt|tags attached)\b/gi;
const CONDITION_VERY_GOOD = /\b(like new|excellent condition|barely worn|hardly used|minimal wear|near mint|almost new|worn once)\b/gi;
const CONDITION_GOOD = /\b(good condition|gently used|light wear|some signs of use|lightly worn|normal wear)\b/gi;
const CONDITION_FAIR = /\b(used|wear and tear|visible signs|needs repair|stains|fading|pilling|minor damage)\b/gi;
const CONDITION_POOR = /\b(damaged|broken|heavily worn|for parts|restoration needed|major damage|torn|ripped)\b/gi;

// Stop words for keyword extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'this', 'that', 'these',
  'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you',
  'your', 'he', 'she', 'his', 'her',
]);

// Icelandic translation dictionary for common product attributes
const ICELANDIC_TRANSLATIONS: Record<string, string> = {
  // Materials
  'Cotton': 'Bómull',
  'Linen': 'Hör',
  'Polyester': 'Pólýester',
  'Leather': 'Leður',
  'Silk': 'Silki',
  'Wool': 'Ull',
  'Cashmere': 'Kasmír',
  'Denim': 'Denim',
  'Suede': 'Súða',
  'Velvet': 'Flauel',
  'Satin': 'Satin',
  'Chiffon': 'Chiffon',
  'Nylon': 'Nylon',
  'Spandex': 'Spandex',
  'Elastane': 'Elastan',
  'Viscose': 'Viskósi',
  'Rayon': 'Rayon',
  'Acrylic': 'Akrýl',
  'Fleece': 'Fleece',

  // Colors
  'Gray': 'Grár',
  'Grey': 'Grár',
  'White': 'Hvítur',
  'Black': 'Svartur',
  'Blue': 'Blár',
  'Red': 'Rauður',
  'Green': 'Grænn',
  'Yellow': 'Gulur',
  'Purple': 'Fjólublár',
  'Brown': 'Brúnn',
  'Beige': 'Beige',
  'Navy': 'Dökkblár',
  'Pink': 'Bleikur',
  'Orange': 'Appelsínugulur',
  'Light': 'Ljós',
  'Dark': 'Dökk',
  'Pale': 'Fölur',
  'Bright': 'Skær',
  'Deep': 'Djúp',

  // Patterns
  'Striped': 'Röndótt',
  'Solid': 'Einfalt',
  'Floral': 'Blómamynstur',
  'Polka dot': 'Prikka',
  'Checkered': 'Terningsmynstur',
  'Plaid': 'Skosk mynstur',

  // Styles
  'Casual': 'Óformlegt',
  'Formal': 'Formlegt',
  'Elegant': 'Glæsilegt',
  'Sporty': 'Íþrótta',
  'Relaxed': 'Afslappaður',
  'Fitted': 'Þröngt',
  'Oversized': 'Stórt',
  'Slim': 'Mjótt',
  'Classic': 'Klassískt',
  'Modern': 'Nútímalegt',
  'Vintage': 'Sígilt',
  'Summer': 'Sumar',
  'Winter': 'Vetur',
  'Spring': 'Vor',
  'Fall': 'Haust',
  'Autumn': 'Haust',

  // Care Instructions
  'Machine wash cold': 'Þvottavél í köldu vatni',
  'Machine wash warm': 'Þvottavél í hlýju vatni',
  'Hand wash only': 'Aðeins handþvottur',
  'Dry clean only': 'Aðeins efnaþvottur',
  'Do not dry clean': 'Ekki efnaþvottur',
  'Tumble dry low': 'Þurrktumbla lágt',
  'Tumble dry medium': 'Þurrktumbla miðlungs',
  'Do not tumble dry': 'Ekki þurrktumbla',
  'Line dry': 'Hengja til þerris',
  'Lay flat to dry': 'Leggja flatt til þerris',
  'Hang to dry': 'Hengja til þerris',
  'Iron on low heat': 'Strauja á lágum hita',
  'Iron on medium heat': 'Strauja á miðlungs hita',
  'Do not iron': 'Ekki strauja',
  'Steam only': 'Aðeins gufa',
  'Cool iron if needed': 'Kalt straujárn ef þörf krefur',
  'Do not bleach': 'Ekki bleikja',
  'Non-chlorine bleach only': 'Aðeins bleikja án klórs',
  'Bleach when needed': 'Bleikja þegar þörf krefur',
  'Professional dry clean': 'Fagleg efnaþvott',
};

/**
 * Category mapping from product type keywords to hierarchical structure
 */
const CATEGORY_MAP: Record<string, { primary: string; secondary: string; tertiary: string }> = {
  // Clothing
  'blouse': { primary: 'Clothing', secondary: 'Women\'s Clothing', tertiary: 'Tops' },
  'shirt': { primary: 'Clothing', secondary: 'Men\'s Clothing', tertiary: 'Tops' },
  'dress': { primary: 'Clothing', secondary: 'Women\'s Clothing', tertiary: 'Dresses' },
  'pants': { primary: 'Clothing', secondary: 'Bottoms', tertiary: 'Pants' },
  'jeans': { primary: 'Clothing', secondary: 'Bottoms', tertiary: 'Jeans' },
  'skirt': { primary: 'Clothing', secondary: 'Women\'s Clothing', tertiary: 'Skirts' },
  'jacket': { primary: 'Clothing', secondary: 'Outerwear', tertiary: 'Jackets' },
  'coat': { primary: 'Clothing', secondary: 'Outerwear', tertiary: 'Coats' },
  'sweater': { primary: 'Clothing', secondary: 'Tops', tertiary: 'Sweaters' },
  't-shirt': { primary: 'Clothing', secondary: 'Tops', tertiary: 'T-Shirts' },

  // Footwear
  'shoes': { primary: 'Footwear', secondary: 'Casual Shoes', tertiary: 'General' },
  'boots': { primary: 'Footwear', secondary: 'Boots', tertiary: 'General' },
  'sneakers': { primary: 'Footwear', secondary: 'Athletic', tertiary: 'Sneakers' },
  'sandals': { primary: 'Footwear', secondary: 'Casual Shoes', tertiary: 'Sandals' },

  // Accessories
  'bag': { primary: 'Accessories', secondary: 'Bags', tertiary: 'Handbags' },
  'watch': { primary: 'Accessories', secondary: 'Jewelry', tertiary: 'Watches' },
  'jewelry': { primary: 'Accessories', secondary: 'Jewelry', tertiary: 'General' },
  'scarf': { primary: 'Accessories', secondary: 'Accessories', tertiary: 'Scarves' },
  'belt': { primary: 'Accessories', secondary: 'Accessories', tertiary: 'Belts' },
};

/**
 * Category hierarchy structure
 */
export interface CategoryPath {
  primary: string;
  secondary: string;
  tertiary: string;
  path: string; // "Primary > Secondary > Tertiary"
}

/**
 * AI confidence scores per attribute (0.0-1.0)
 */
export interface AIConfidence {
  brand?: number;
  material?: number;
  colors?: number;
  pattern?: number;
  style?: number;
  keywords?: number;
  category?: number;
  careInstructions?: number;
  conditionRating?: number;
}

/**
 * Icelandic translations for extracted attributes
 */
export interface IcelandicTranslations {
  material?: string | null;
  colors?: string[];
  pattern?: string | null;
  style?: string[];
  careInstructions?: string[];
}

/**
 * Extraction result with all optional attributes
 */
export interface ExtractionResult {
  brand?: string | null;
  material?: string | null;
  colors?: string[];
  pattern?: string | null;
  style?: string[];
  sustainability?: string[];
  keywords?: string[];
  category?: CategoryPath;
  careInstructions?: string[];
  conditionRating?: number; // 1-5 star rating
  aiConfidence?: AIConfidence;
  // Season/occasion from Mistral vision analysis
  season?: string | null;
  occasion?: string[];
  // Pricing intelligence hints from Mistral
  pricingHints?: {
    rarity?: string;
    craftsmanship?: string;
    marketDemand?: string;
    estimatedAgeYears?: number;
    brandTier?: string;
  };
  // Image alt text for SEO (generated from extracted attributes)
  imageAltText?: string | null;
  translations?: {
    is?: IcelandicTranslations; // Icelandic translations
  };
}

/**
 * Main extraction function
 * Runs all attribute-extraction rules on the supplied product data
 */
export function extractAttributes(
  product: { productName: string; bilingualDescription: MultilingualProductDescription },
  mistralResult?: MistralPixtralAnalysisResult
): ExtractionResult {
  // If AI extraction is enabled and Mistral results are available, use AI-native path
  if (USE_AI_EXTRACTION && mistralResult) {
    return extractFromAI(mistralResult, product);
  }

  // Otherwise, fall back to regex-based extraction (backward compatibility)
  const enDesc = product.bilingualDescription.en;
  const descriptionEn = enDesc?.long || '';
  const shortEn = enDesc?.short || '';
  const title = product.productName;

  // Combine title and description for comprehensive extraction
  const fullText = `${title} ${shortEn} ${descriptionEn}`;

  // Extract brand
  const { brand, confidence: brandScore} = extractBrand(title, fullText);

  // Extract material
  const { material, confidence: materialScore } = extractMaterial(fullText);

  // Extract colors
  const { colors, confidence: colorsScore } = extractColors(fullText);

  // Extract pattern
  const { pattern, confidence: patternScore } = extractPattern(title, fullText);

  // Extract style and sustainability
  const { style, sustainability, confidence: styleScore } = extractStyleAndSustainability(fullText);

  // Extract care instructions
  const { careInstructions, confidence: careInstructionsScore } = extractCareInstructions(fullText);

  // Extract condition rating
  const { conditionRating, confidence: conditionRatingScore } = extractConditionRating(fullText);

  // Extract keywords (includes brand, material, colors, pattern, style)
  const { keywords, confidence: keywordsScore } = extractKeywords({
    title,
    description: fullText,
    brand,
    material,
    colors,
    pattern,
    style,
    sustainability,
  });

  // Extract category hierarchy
  const { category, confidence: categoryScore } = extractCategory({
    title,
    description: fullText,
    material,
    pattern,
    style,
  });

  // Assemble confidence map
  const aiConfidence: AIConfidence = {
    brand: brandScore,
    material: materialScore,
    colors: colorsScore,
    pattern: patternScore,
    style: styleScore,
    keywords: keywordsScore,
    category: categoryScore,
    careInstructions: careInstructionsScore,
    conditionRating: conditionRatingScore,
  };

  // Create base result
  const baseResult: ExtractionResult = {
    brand,
    material,
    colors,
    pattern,
    style,
    sustainability,
    keywords,
    category,
    careInstructions,
    conditionRating,
    aiConfidence,
    // Generate image alt text from extracted attributes for SEO
    imageAltText: generateImageAltText({
      brand,
      material,
      colors,
      category: category?.path,
      productName: title,
    }),
  };

  // Add Icelandic translations
  const icelandicTranslations = translateToIcelandic(baseResult);

  return {
    ...baseResult,
    translations: {
      is: icelandicTranslations,
    },
  };
}

/**
 * Extract brand from product name and description
 */
function extractBrand(title: string, description: string): { brand: string | null; confidence: number } {
  const titleLower = title.toLowerCase();

  // Check first word of title against known brands
  const firstWord = titleLower.split(/\s+/)[0];
  if (KNOWN_BRANDS.has(firstWord)) {
    return {
      brand: title.split(/\s+/)[0], // Preserve original casing
      confidence: 0.95,
    };
  }

  // Check entire title for brand match
  const brandsArray = Array.from(KNOWN_BRANDS);
  for (const brand of brandsArray) {
    if (titleLower.includes(brand)) {
      return {
        brand: brand.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
        confidence: 0.90,
      };
    }
  }

  // Fallback: extract capitalized words from title (brand entity heuristic)
  // Skip generic adjectives/colors/conditions that are not brand names
  const NON_BRAND_WORDS = new Set([
    'classic', 'vintage', 'new', 'used', 'good', 'great', 'nice', 'black',
    'white', 'blue', 'red', 'green', 'brown', 'grey', 'gray', 'pink',
    'yellow', 'orange', 'purple', 'navy', 'beige', 'cream', 'dark', 'light',
    'slim', 'regular', 'relaxed', 'fitted', 'oversized', 'skinny', 'straight',
    'bootcut', 'flare', 'cropped', 'wide', 'high', 'low', 'mid',
    'men', 'women', 'kids', 'boys', 'girls', 'unisex', 'ladies',
    'denim', 'jeans', 'jacket', 'shirt', 'dress', 'skirt', 'pants',
    'trousers', 'shorts', 'coat', 'blazer', 'sweater', 'hoodie', 'top',
    'condition', 'minimal', 'signs', 'wear', 'very',
  ]);
  const capitalizedWords = title.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/g) || [];
  const brandCandidate = capitalizedWords.find(word => !NON_BRAND_WORDS.has(word.toLowerCase()));
  if (brandCandidate) {
    return {
      brand: brandCandidate,
      confidence: 0.70, // Lower confidence for inferred brands
    };
  }

  return { brand: null, confidence: 0.50 };
}

/**
 * Extract material from description
 */
function extractMaterial(text: string): { material: string | null; confidence: number } {
  const matches = text.match(MATERIAL_PATTERNS);

  if (matches && matches.length > 0) {
    // Return the first material found
    const material = matches[0].toLowerCase();

    // Check if percentage is mentioned (e.g., "100% cotton")
    const percentagePattern = new RegExp(`(\\d+)%\\s*${material}`, 'i');
    const percentageMatch = text.match(percentagePattern);

    if (percentageMatch) {
      return {
        material: material.charAt(0).toUpperCase() + material.slice(1),
        confidence: 0.95, // High confidence with percentage
      };
    }

    return {
      material: material.charAt(0).toUpperCase() + material.slice(1),
      confidence: 0.90,
    };
  }

  return { material: null, confidence: 0.50 };
}

/**
 * Extract colors from description
 */
function extractColors(text: string): { colors: string[]; confidence: number } {
  const matches = text.match(COLOR_PATTERNS);

  if (matches && matches.length > 0) {
    // Deduplicate and capitalize colors
    const colorSet = new Set(matches.map(color => {
      return color.trim()
        .split(/\s+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }));
    const uniqueColors = Array.from(colorSet);

    return {
      colors: uniqueColors,
      confidence: 0.85,
    };
  }

  return { colors: [], confidence: 0.50 };
}

/**
 * Extract pattern from title and description
 */
function extractPattern(title: string, description: string): { pattern: string | null; confidence: number } {
  // Check title first (higher priority)
  const titleMatch = title.match(PATTERN_KEYWORDS);
  if (titleMatch) {
    return {
      pattern: titleMatch[0].charAt(0).toUpperCase() + titleMatch[0].slice(1).toLowerCase(),
      confidence: 0.95,
    };
  }

  // Check description
  const descMatch = description.match(PATTERN_KEYWORDS);
  if (descMatch) {
    return {
      pattern: descMatch[0].charAt(0).toUpperCase() + descMatch[0].slice(1).toLowerCase(),
      confidence: 0.85,
    };
  }

  return { pattern: null, confidence: 0.50 };
}

/**
 * Extract care instructions from description
 */
function extractCareInstructions(text: string): { careInstructions: string[]; confidence: number } {
  const matches = text.match(CARE_INSTRUCTION_PATTERNS);

  if (matches && matches.length > 0) {
    // Deduplicate and capitalize care instructions
    const instructionSet = new Set(matches.map(instruction => {
      return instruction.trim()
        .split(/\s+/)
        .map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase())
        .join(' ');
    }));
    const uniqueInstructions = Array.from(instructionSet);

    return {
      careInstructions: uniqueInstructions,
      confidence: 0.90,
    };
  }

  return { careInstructions: [], confidence: 0.50 };
}

/**
 * Extract condition rating from description (1-5 stars)
 * Based on condition keywords and descriptions
 */
function extractConditionRating(text: string): { conditionRating: number; confidence: number } {
  // Check for excellent condition (5 stars)
  if (CONDITION_EXCELLENT.test(text)) {
    return { conditionRating: 5, confidence: 0.95 };
  }

  // Check for very good condition (4 stars)
  if (CONDITION_VERY_GOOD.test(text)) {
    return { conditionRating: 4, confidence: 0.90 };
  }

  // Check for good condition (3 stars)
  if (CONDITION_GOOD.test(text)) {
    return { conditionRating: 3, confidence: 0.85 };
  }

  // Check for fair condition (2 stars)
  if (CONDITION_FAIR.test(text)) {
    return { conditionRating: 2, confidence: 0.80 };
  }

  // Check for poor condition (1 star)
  if (CONDITION_POOR.test(text)) {
    return { conditionRating: 1, confidence: 0.85 };
  }

  // Default: assume good condition (3 stars) with lower confidence
  return { conditionRating: 3, confidence: 0.50 };
}

/**
 * Translate extracted attributes to Icelandic
 * Uses a translation dictionary for common product terms
 */
function translateToIcelandic(result: ExtractionResult): IcelandicTranslations {
  const translations: IcelandicTranslations = {};

  // Translate material
  if (result.material) {
    translations.material = ICELANDIC_TRANSLATIONS[result.material] || result.material;
  }

  // Translate colors
  if (result.colors && result.colors.length > 0) {
    translations.colors = result.colors.map(color => {
      // Handle multi-word colors (e.g., "Light Gray")
      const words = color.split(' ');
      const translatedWords = words.map(word => ICELANDIC_TRANSLATIONS[word] || word);
      return translatedWords.join(' ');
    });
  }

  // Translate pattern
  if (result.pattern) {
    translations.pattern = ICELANDIC_TRANSLATIONS[result.pattern] || result.pattern;
  }

  // Translate style tags
  if (result.style && result.style.length > 0) {
    translations.style = result.style.map(style =>
      ICELANDIC_TRANSLATIONS[style] || style
    );
  }

  // Translate care instructions
  if (result.careInstructions && result.careInstructions.length > 0) {
    translations.careInstructions = result.careInstructions.map(instruction =>
      ICELANDIC_TRANSLATIONS[instruction] || instruction
    );
  }

  return translations;
}

/**
 * Extract style adjectives and sustainability tags
 */
function extractStyleAndSustainability(text: string): {
  style: string[];
  sustainability: string[];
  confidence: number;
} {
  const styleMatches = text.match(STYLE_ADJECTIVES);
  const seasonalMatches = text.match(SEASONAL_KEYWORDS);
  const sustainabilityMatches = text.match(SUSTAINABILITY_KEYWORDS);

  const style: string[] = [];

  if (styleMatches) {
    style.push(...styleMatches.map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()));
  }

  if (seasonalMatches) {
    style.push(...seasonalMatches.map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()));
  }

  const sustainability = sustainabilityMatches
    ? sustainabilityMatches.map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    : [];

  // Deduplicate
  const uniqueStyle = Array.from(new Set(style));
  const uniqueSustainability = Array.from(new Set(sustainability));

  const confidence = uniqueStyle.length > 0 || uniqueSustainability.length > 0 ? 0.85 : 0.50;

  return { style: uniqueStyle, sustainability: uniqueSustainability, confidence };
}

/**
 * Extract keywords from all attributes and description text
 */
function extractKeywords(params: {
  title: string;
  description: string;
  brand?: string | null;
  material?: string | null;
  colors?: string[];
  pattern?: string | null;
  style?: string[];
  sustainability?: string[];
}): { keywords: string[]; confidence: number } {
  const keywords = new Set<string>();

  // Add extracted attributes
  if (params.brand) keywords.add(params.brand.toLowerCase());
  if (params.material) keywords.add(params.material.toLowerCase());
  if (params.pattern) keywords.add(params.pattern.toLowerCase());
  if (params.colors) params.colors.forEach(color => keywords.add(color.toLowerCase()));
  if (params.style) params.style.forEach(style => keywords.add(style.toLowerCase()));
  if (params.sustainability) params.sustainability.forEach(tag => keywords.add(tag.toLowerCase()));

  // Extract meaningful words from description
  const words = params.description
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !STOP_WORDS.has(word));

  words.forEach(word => keywords.add(word));

  // Extract product type from title (e.g., "blouse", "shirt", "dress")
  const titleWords = params.title.toLowerCase().split(/\s+/);
  titleWords.forEach(word => {
    if (word.length > 3 && !STOP_WORDS.has(word)) {
      keywords.add(word);
    }
  });

  const keywordArray = Array.from(keywords).slice(0, 20); // Limit to 20 keywords

  return {
    keywords: keywordArray,
    confidence: keywordArray.length > 0 ? 0.85 : 0.50,
  };
}

/**
 * Extract hierarchical category from product type keywords
 */
function extractCategory(params: {
  title: string;
  description: string;
  material?: string | null;
  pattern?: string | null;
  style?: string[];
}): { category: CategoryPath | null; confidence: number } {
  const titleLower = params.title.toLowerCase();
  const descriptionLower = params.description.toLowerCase();

  // Check title for product type keywords
  for (const [keyword, categoryInfo] of Object.entries(CATEGORY_MAP)) {
    if (titleLower.includes(keyword)) {
      return {
        category: {
          ...categoryInfo,
          path: `${categoryInfo.primary} > ${categoryInfo.secondary} > ${categoryInfo.tertiary}`,
        },
        confidence: 0.90,
      };
    }
  }

  // Check description for product type keywords
  for (const [keyword, categoryInfo] of Object.entries(CATEGORY_MAP)) {
    if (descriptionLower.includes(keyword)) {
      return {
        category: {
          ...categoryInfo,
          path: `${categoryInfo.primary} > ${categoryInfo.secondary} > ${categoryInfo.tertiary}`,
        },
        confidence: 0.80,
      };
    }
  }

  // Fallback to generic category
  return {
    category: {
      primary: 'General',
      secondary: 'Miscellaneous',
      tertiary: 'Uncategorized',
      path: 'General > Miscellaneous > Uncategorized',
    },
    confidence: 0.60,
  };
}

/**
 * Extract attributes from Mistral Pixtral AI results (AI-native extraction)
 * Replaces regex-based extraction with direct AI-derived attributes
 *
 * @param mistralResult - Comprehensive AI analysis from Mistral Pixtral
 * @param product - Product with bilingual descriptions (for translation fallback)
 * @returns ExtractionResult with AI-extracted attributes
 */
function extractFromAI(
  mistralResult: MistralPixtralAnalysisResult,
  product: { productName: string; bilingualDescription: MultilingualProductDescription }
): ExtractionResult {
  // Parse category path (Mistral returns "Primary/Secondary/Tertiary" format)
  const categoryParts = (mistralResult.category || 'General').split('/');
  const primary = categoryParts[0] || 'Clothing';
  const secondary = categoryParts[1] || 'General';
  const tertiary = categoryParts[2] || 'Items';

  // Brand normalization: canonicalize Mistral's brand output against KNOWN_BRANDS
  const normalizedBrand = normalizeBrand(mistralResult.brand);

  return {
    // Core attributes from AI
    brand: normalizedBrand,
    material: mistralResult.material || null,
    colors: mistralResult.colors || [],
    pattern: mistralResult.pattern || null,
    style: mistralResult.style || [],

    // Sustainability: Not extracted by AI yet, return empty array
    sustainability: [],

    // Keywords from AI
    keywords: mistralResult.keywords || [],

    // Category hierarchy
    category: {
      primary,
      secondary,
      tertiary,
      path: `${primary} > ${secondary} > ${tertiary}`
    },

    // Care instructions from AI
    careInstructions: mistralResult.careInstructions || [],

    // Condition rating (map AI condition to 1-5 scale)
    conditionRating: mapConditionToRating(mistralResult.condition),

    // Season and occasion from Mistral vision analysis
    season: mistralResult.season || null,
    occasion: mistralResult.occasion || [],

    // Pricing intelligence hints from Mistral
    pricingHints: mistralResult.pricingHints || undefined,

    // Generate image alt text from extracted attributes for SEO
    imageAltText: generateImageAltText({
      brand: mistralResult.brand,
      material: mistralResult.material,
      colors: mistralResult.colors,
      category: `${primary} ${secondary}`.trim(),
      condition: mistralResult.condition,
      productName: product.productName,
    }),

    // AI confidence scores (use Mistral's confidence or fallback)
    aiConfidence: {
      brand: mistralResult.aiConfidence?.brand || (mistralResult.brand ? 0.8 : 0.0),
      material: mistralResult.aiConfidence?.material || (mistralResult.material ? 0.8 : 0.0),
      colors: mistralResult.aiConfidence?.colors || 0.8,
      pattern: mistralResult.pattern ? 0.8 : 0.0,
      style: mistralResult.style && mistralResult.style.length > 0 ? 0.8 : 0.0,
      keywords: mistralResult.aiConfidence?.overall || 0.85,
      category: mistralResult.aiConfidence?.category || 0.85,
      careInstructions: mistralResult.careInstructions && mistralResult.careInstructions.length > 0 ? 0.8 : 0.0,
      conditionRating: mistralResult.aiConfidence?.condition || 0.85
    },

    // Icelandic translations (fallback to regex-based translation)
    translations: {
      is: {
        material: translateMaterial(mistralResult.material),
        colors: mistralResult.colors?.map(translateColor) || [],
        pattern: translatePattern(mistralResult.pattern),
        style: mistralResult.style?.map(translateStyle) || [],
        careInstructions: mistralResult.careInstructions?.map(translateCareInstruction) || []
      }
    }
  };
}

// Canonical display names for brands that need special casing
// (ampersands, apostrophes, acronyms, etc.) — only brands that title-casing
// alone cannot handle correctly. KNOWN_BRANDS keys are the lookup keys.
const BRAND_DISPLAY_NAME: Record<string, string> = {
  'h&m': 'H&M',
  "levi's": "Levi's",
  'levis': "Levi's",
  'levi': "Levi's",
  'g-star raw': 'G-Star Raw',
  'g-star': 'G-Star',
  'nudie jeans': 'Nudie Jeans',
  '&otherstories': '&Other Stories',
  'cos': 'COS',
  'dr. denim': 'Dr. Denim',
  'arc\'teryx': 'Arc\'teryx',
};

/**
 * Normalize a brand name against KNOWN_BRANDS for canonical display casing.
 * Mistral may return "ZARA", "zara", or "Zara" — we canonicalize using
 * BRAND_DISPLAY_NAME for special cases, or title case for everything else.
 */
function normalizeBrand(brand?: string | null): string | null {
  if (!brand) return null;
  const lower = brand.toLowerCase().trim();
  // Check special display-name overrides first
  if (BRAND_DISPLAY_NAME[lower]) return BRAND_DISPLAY_NAME[lower];
  // If it's a known brand, title-case it
  if (KNOWN_BRANDS.has(lower)) {
    return lower.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  // Unknown brand — return as-is with first letter capitalised
  return brand.trim().charAt(0).toUpperCase() + brand.trim().slice(1);
}

/**
 * Seed KNOWN_BRANDS and BRAND_DISPLAY_NAME from the DynamoDB brand registry.
 * Call this once during Lambda cold start to supplement the hardcoded lists.
 * Safe to call multiple times — skips brands already present.
 *
 * @param registeredBrands - Map of brandLower → displayName from BrandRegistry.loadRegisteredBrands()
 */
export function seedBrandsFromRegistry(registeredBrands: Map<string, string>): void {
  for (const [lower, display] of registeredBrands) {
    KNOWN_BRANDS.add(lower);
    // Only add to BRAND_DISPLAY_NAME when title-casing would be wrong
    // (i.e. the display name differs from a naive title-case)
    const titleCased = lower.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    if (display !== titleCased) {
      BRAND_DISPLAY_NAME[lower] = display;
    }
  }
}

/**
 * Generate descriptive alt text for product images (SEO)
 * Combines brand, material, color, category, and condition for rich descriptions
 */
function generateImageAltText(attrs: {
  brand?: string | null;
  material?: string | null;
  colors?: string[];
  category?: string;
  condition?: string;
  productName?: string;
}): string {
  const parts: string[] = [];

  if (attrs.colors && attrs.colors.length > 0) parts.push(attrs.colors[0]);
  if (attrs.brand) parts.push(attrs.brand);
  if (attrs.material) parts.push(attrs.material);
  if (attrs.category) parts.push(attrs.category);

  // Map condition to human-readable label
  const conditionLabels: Record<string, string> = {
    new_with_tags: 'new with tags',
    like_new: 'like new',
    very_good: 'very good condition',
    good: 'good condition',
    fair: 'fair condition',
  };
  if (attrs.condition && conditionLabels[attrs.condition]) {
    parts.push(`in ${conditionLabels[attrs.condition]}`);
  }

  if (parts.length > 0) return parts.join(' ');
  return attrs.productName || 'Product image';
}

/**
 * Map AI condition assessment to 1-5 rating scale
 * @private
 */
function mapConditionToRating(condition: string): number {
  const ratings: Record<string, number> = {
    new_with_tags: 5,
    like_new: 4,
    very_good: 4,
    good: 3,
    fair: 2
  };
  return ratings[condition] || 3; // Default to 3 (good)
}
