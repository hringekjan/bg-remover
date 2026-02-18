/**
 * Product Name Analyzer
 * 
 * Extracts brand names, condition hints, and quality indicators
 * from product names and descriptions.
 */

import type { ProductNameAnalysis } from './types';

/**
 * Icelandic brand name patterns
 */
const ICELANDIC_BRANDS: Record<string, string> = {
  'boss': 'Boss',
  'gucci': 'Gucci',
  'prada': 'Prada',
  'chanel': 'Chanel',
  'dior': 'Dior',
  'versace': 'Versace',
  'armani': 'Armani',
  'ralph lauren': 'Ralph Lauren',
  'tommy hilfiger': 'Tommy Hilfiger',
  'calvin klein': 'Calvin Klein',
  'michael kors': 'Michael Kors',
  'kate spade': 'Kate Spade',
  'coach': 'Coach',
  'marc jacobs': 'Marc Jacobs',
  'burberry': 'Burberry',
  'hermes': 'Hermès',
  'cartier': 'Cartier',
  'rolex': 'Rolex',
  'omega': 'Omega',
  'patek': 'Patek Philippe',
  'tag heuer': 'Tag Heuer',
  'vintage': 'Vintage',
  '冰岛': 'Icelandic',
  'íslenskt': 'Icelandic',
  'hring': 'Hringir',
  '68°': '68 North',
  'the blue lagoon': 'Blue Lagoon',
  'foss': 'Foss',
  'c卑': 'C卑',
};

/**
 * Condition indicators in product names
 */
const CONDITION_INDICATORS: Record<string, string[]> = {
  'new_with_tags': [
    'með merkjum', 'með álíka', 'new with tags', 'new with tag', 
    'unused', 'ó.notað', 'brand new', 'n\xfdtt', 'nytt',
    'innkaupakassar', '未使用', '全新',
  ],
  'like_new': [
    'n\xfdtt', 'nýtt', 'new', 'close to new', 'almost new',
    'l\xedkt og n\xfdtt', 'minimal wear', 'sparsamlega nota\xf0',
    'practically new', 'almost perfect',
  ],
  'very_good': [
    'mjög gott', 'very good', 'gott \xe1stand', 'good condition',
    'gott', 'vel haldi\xf0', 'well kept', 'f\xednt',
    'mikið haldi\xf0', 'great condition', 'finna',
  ],
  'good': [
    'gott', 'good', 'sæmilegt', 'fair', 'okkar',
    'nota\xf0', 'used', 'regular', 'standard',
  ],
  'fair': [
    'sæmilegt', 'fair', 'þarft við', 'needs repair',
    'ætti að', 'þvotta', 'worn', 'þvottur',
  ],
};

/**
 * Size patterns for clothing
 */
const SIZE_PATTERNS = {
  numeric: /\b(\d{2})\b/,  // 36, 38, 40, 42...
  letter: /\b([xsXMLmL]+)\b/i,  // XS, S, M, L, XL, XXL
  letter_with_slash: /\b([xsml])\/([xsml])\b/gi,  // S/M, L/XL
};

/**
 * Color extraction patterns
 */
const COLOR_PATTERNS: Record<string, RegExp[]> = {
  '#FFFFFF': [/\b(white|hvítur|hvítt|white)\b/i],
  '#000000': [/\b(black|svartur|svart|black)\b/i],
  '#FF0000': [/\b(red|rauður|rautt|red)\b/i],
  '#0000FF': [/\b(blue|blár|blátt|blue)\b/i],
  '#00FF00': [/\b(green|grænn|grænt|green)\b/i],
  '#FFFF00': [/\b(yellow|gulur|gult|yellow)\b/i],
  '#FFA500': [/\b(orange|appelsínugulur|appelsínugult|orange)\b/i],
  '#800080': [/\b(purple|fiolusár|fiolusárt|purple)\b/i],
  '#FFC0CB': [/\b(pink|bleikur|bleikt|pink)\b/i],
  '#A52A2A': [/\b(brown|brúnn|brúnt|brown)\b/i],
  '#808080': [/\b(gray|grár|grátt|gray|grey|grár|grátt)\b/i],
  '#000080': [/\b(navy|marine|navy|marine)\b/i],
};

/**
 * Gender/audience patterns
 */
const GENDER_PATTERNS: Record<string, RegExp[]> = {
  'male': [/(?:maður|manns|karl|drengur|pabbi|karlmanns)/],
  'female': [/(?:kona|stullda|freta|gala|mamma|stúlka)/],
  'unisex': [/(?:unisex|allir|bæði kyn)/],
  'kids': [/(?:barn|börnin|barnanna|barnasýsla|unglingur)/],
};

/**
 * Product type keywords
 */
const PRODUCT_TYPE_KEYWORDS: Record<string, string[]> = {
  pants: ['buksur', 'gallabuxur', 'pants', 'trousers', 'jeans', 'joggers', 'leggings'],
  jacket: ['jakki', 'jacket', 'kapa', 'coat', 'parka', 'anorak'],
  dress: ['kjóll', 'dress', 'róba', 'gala'],
  skirt: ['skirt', 'skirta'],
  top: ['bolur', 'top', 'blúsa', 'blouse', 'vesti', 'vest', 'sweater'],
  shoes: ['skor', 'shoes', 'skór', 'boots', 'støvlu', 'sneakers'],
  bag: ['taska', 'bag', 'veski', 'handbag', 'pungur', 'wallet'],
  accessories: ['húfa', 'hat', 'belt', 'scarf', 'sjal', 'gleraugu'],
};

/**
 * Analyze product name to extract brand, condition, and other attributes
 */
export function analyzeProductName(productName: string): ProductNameAnalysis {
  const analysis: ProductNameAnalysis = {
    keywords: [],
    extractionConfidence: 0,
  };

  const normalizedName = productName.toLowerCase();
  const words = normalizedName.split(/\s+/);

  // Extract brand
  const brand = extractBrand(productName, normalizedName);
  if (brand) {
    analysis.brand = brand;
    analysis.keywords.push(brand.toLowerCase());
  }

  // Extract condition
  const condition = extractCondition(normalizedName);
  if (condition) {
    analysis.condition = condition;
  }

  // Extract size
  const size = extractSize(productName);
  if (size) {
    analysis.size = size;
    analysis.keywords.push(size);
  }

  // Extract color
  const color = extractColor(normalizedName);
  if (color) {
    analysis.color = color;
    analysis.keywords.push(color);
  }

  // Extract gender
  const gender = extractGender(normalizedName);
  if (gender) {
    analysis.gender = gender;
  }

  // Extract product type
  const productType = extractProductType(normalizedName);
  if (productType) {
    analysis.productType = productType;
    analysis.keywords.push(productType);
  }

  // Calculate extraction confidence based on what we found
  analysis.extractionConfidence = calculateConfidence(analysis, productName);

  return analysis;
}

/**
 * Extract brand name from product name
 */
function extractBrand(productName: string, normalizedName: string): string | undefined {
  // Check known brands
  for (const [pattern, brand] of Object.entries(ICELANDIC_BRANDS)) {
    if (normalizedName.includes(pattern.toLowerCase())) {
      return brand;
    }
  }

  // Check for common brand patterns
  const brandPatterns = [
    /\b([A-Z][a-zA-Z]+)\s+(?:the\s+)?([A-Z][a-zA-Z]+)\b/,  // "Brand Name" pattern
    /\b(?:the\s+)?([A-Z][a-zA-Z]+)\s+(?:collection|line|style)\b/,
  ];

  for (const pattern of brandPatterns) {
    const match = productName.match(pattern);
    if (match) {
      return match[1] + (match[2] ? ' ' + match[2] : '');
    }
  }

  return undefined;
}

/**
 * Extract condition from product name
 */
function extractCondition(normalizedName: string): ProductNameAnalysis['condition'] {
  // Check condition indicators
  for (const [condition, indicators] of Object.entries(CONDITION_INDICATORS)) {
    for (const indicator of indicators) {
      if (normalizedName.includes(indicator.toLowerCase())) {
        return condition as ProductNameAnalysis['condition'];
      }
    }
  }

  return undefined;
}

/**
 * Extract size from product name
 */
function extractSize(productName: string): string | undefined {
  // Check numeric sizes (36-52 for Icelandic clothing)
  const numericMatch = productName.match(SIZE_PATTERNS.numeric);
  if (numericMatch) {
    const size = numericMatch[1];
    if (parseInt(size) >= 30 && parseInt(size) <= 60) {
      return size;
    }
  }

  // Check letter sizes
  const letterMatch = productName.match(SIZE_PATTERNS.letter);
  if (letterMatch) {
    return letterMatch[1].toUpperCase();
  }

  // Check S/M, L/XL patterns
  const slashMatch = productName.match(SIZE_PATTERNS.letter_with_slash);
  if (slashMatch) {
    return slashMatch[1].toUpperCase() + '/' + slashMatch[2].toUpperCase();
  }

  return undefined;
}

/**
 * Extract color from product name
 */
function extractColor(normalizedName: string): string | undefined {
  for (const [hexColor, patterns] of Object.entries(COLOR_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(normalizedName)) {
        // Return color name instead of hex
        return hexColor;
      }
    }
  }

  // Also check for common color names without hex
  const commonColors: Record<string, string> = {
    'black': '#000000',
    'white': '#FFFFFF',
    'navy': '#000080',
    'beige': '#F5F5DC',
    'camel': '#C19A6B',
    'burgundy': '#800020',
    'forest green': '#228B22',
    'olive': '#808000',
    'maroon': '#800000',
    'cream': '#FFFDD0',
    'taupe': '#483C32',
  };

  for (const [colorName, hexColor] of Object.entries(commonColors)) {
    if (normalizedName.includes(colorName)) {
      return hexColor;
    }
  }

  return undefined;
}

/**
 * Extract gender/audience from product name
 */
function extractGender(normalizedName: string): ProductNameAnalysis['gender'] {
  for (const [gender, patterns] of Object.entries(GENDER_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(normalizedName)) {
        return gender as ProductNameAnalysis['gender'];
      }
    }
  }

  return undefined;
}

/**
 * Extract product type from product name
 */
function extractProductType(normalizedName: string): string | undefined {
  for (const [type, keywords] of Object.entries(PRODUCT_TYPE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (normalizedName.includes(keyword)) {
        return type;
      }
    }
  }

  return undefined;
}

/**
 * Calculate confidence score for extraction
 */
function calculateConfidence(
  analysis: ProductNameAnalysis,
  originalName: string
): number {
  let score = 0;
  let maxScore = 0;

  // Brand extraction (weight: 0.3)
  maxScore += 0.3;
  if (analysis.brand) score += 0.3;

  // Condition extraction (weight: 0.25)
  maxScore += 0.25;
  if (analysis.condition) score += 0.25;

  // Size extraction (weight: 0.15)
  maxScore += 0.15;
  if (analysis.size) score += 0.15;

  // Color extraction (weight: 0.15)
  maxScore += 0.15;
  if (analysis.color) score += 0.15;

  // Product type extraction (weight: 0.15)
  maxScore += 0.15;
  if (analysis.productType) score += 0.15;

  return score / maxScore;
}

/**
 * Calculate price adjustment based on product analysis
 */
export function calculateAdjustments(analysis: ProductNameAnalysis): {
  brandAdjustment: number;
  conditionAdjustment: number;
} {
  // Brand premium adjustments
  const brandMultipliers: Record<string, number> = {
    // Luxury brands
    'gucci': 2.5,
    'prada': 2.5,
    'chanel': 3.0,
    'hermes': 3.5,
    'dior': 2.5,
    'versace': 2.0,
    'burberry': 2.0,
    // Premium brands
    'boss': 1.8,
    'ralph lauren': 1.6,
    'tommy hilfiger': 1.5,
    'calvin klein': 1.4,
    'michael kors': 1.4,
    'coach': 1.3,
    'kate spade': 1.3,
    // Mid-range
    'armani': 1.5,
    'marc jacobs': 1.4,
    // Watch brands
    'rolex': 4.0,
    'omega': 3.0,
    'cartier': 3.5,
    // Vintage
    'vintage': 1.2,
    // Icelandic
    '68°': 1.3,
    'the blue lagoon': 1.2,
    'foss': 1.1,
  };

  let brandAdjustment = 1.0;
  if (analysis.brand) {
    const brandLower = analysis.brand.toLowerCase();
    for (const [pattern, multiplier] of Object.entries(brandMultipliers)) {
      if (brandLower.includes(pattern.toLowerCase())) {
        brandAdjustment = multiplier;
        break;
      }
    }
  }

  // Condition adjustments
  const conditionMultipliers: Record<string, number> = {
    'new_with_tags': 1.0,
    'like_new': 0.90,
    'very_good': 0.80,
    'good': 0.70,
    'fair': 0.55,
  };

  const conditionAdjustment = analysis.condition
    ? conditionMultipliers[analysis.condition] || 1.0
    : 1.0;

  return {
    brandAdjustment,
    conditionAdjustment,
  };
}
