// src/lib/ai-extractor.ts
/**
 * AI Attribute Extractor
 *
 * Extracts structured product attributes from AI-generated descriptions
 * Uses lightweight regex patterns for brand, material, colors, pattern, style,
 * keywords, and hierarchical category classification.
 *
 * All new fields are optional for backwards compatibility.
 */

import type { MultilingualProductDescription, ProductDescription } from './types';

// Known brand list for direct matching
const KNOWN_BRANDS = new Set([
  'abercrombie', 'adidas', 'armani', 'balenciaga', 'burberry', 'calvin klein',
  'cartier', 'chanel', 'coach', 'dior', 'dolce & gabbana', 'fendi', 'gap',
  'gucci', 'h&m', 'hermès', 'hugo boss', 'lacoste', 'levi', 'louis vuitton',
  'mango', 'michael kors', 'nike', 'prada', 'puma', 'ralph lauren', 'rolex',
  'tiffany', 'tommy hilfiger', 'uniqlo', 'versace', 'zara', '&otherstories',
  'cos', 'mango', 'massimo dutti', 'pull & bear', 'bershka', 'stradivarius',
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
}

/**
 * Main extraction function
 * Runs all attribute-extraction rules on the supplied product data
 */
export function extractAttributes(
  product: { productName: string; bilingualDescription: MultilingualProductDescription }
): ExtractionResult {
  const enDesc = product.bilingualDescription.en;
  const descriptionEn = enDesc?.long || '';
  const shortEn = enDesc?.short || '';
  const title = product.productName;

  // Combine title and description for comprehensive extraction
  const fullText = `${title} ${shortEn} ${descriptionEn}`;

  // Extract brand
  const { brand, confidence: brandScore } = extractBrand(title, fullText);

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

  return {
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
  const capitalizedMatch = title.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/);
  if (capitalizedMatch) {
    return {
      brand: capitalizedMatch[1],
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
