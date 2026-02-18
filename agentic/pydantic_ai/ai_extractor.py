import re
from typing import List, Optional, Dict, Any, Set, Literal

from pydantic import BaseModel, Field

# Import from previously created Pydantic-AI modules
from .mistral_pixtral_analyzer import MistralPixtralAnalysisResult
from .image_analysis import BilingualProductDescription as MultilingualProductDescription, ProductDescription

# Feature flag: Enable AI-native extraction (default: false for gradual rollout)
# This will be controlled externally, or by an env var in the Python context
USE_AI_EXTRACTION = False # process.env.USE_AI_EXTRACTION === 'true';


# --- Pydantic Models for ExtractionResult ---

class CategoryPath(BaseModel):
    primary: str
    secondary: str
    tertiary: str
    path: str = Field(..., description="e.g., 'Primary > Secondary > Tertiary'")

class AIConfidence(BaseModel):
    brand: Optional[float] = None
    material: Optional[float] = None
    colors: Optional[float] = None
    pattern: Optional[float] = None
    style: Optional[float] = None
    keywords: Optional[float] = None
    category: Optional[float] = None
    careInstructions: Optional[float] = None
    conditionRating: Optional[float] = None

class IcelandicTranslations(BaseModel):
    material: Optional[str] = None
    colors: Optional[List[str]] = None
    pattern: Optional[str] = None
    style: Optional[List[str]] = None
    careInstructions: Optional[List[str]] = None

class ExtractionResult(BaseModel):
    brand: Optional[str] = None
    material: Optional[str] = None
    colors: Optional[List[str]] = Field(default_factory=list)
    pattern: Optional[str] = None
    style: Optional[List[str]] = Field(default_factory=list)
    sustainability: Optional[List[str]] = Field(default_factory=list)
    keywords: Optional[List[str]] = Field(default_factory=list)
    category: Optional[CategoryPath] = None
    careInstructions: Optional[List[str]] = Field(default_factory=list)
    conditionRating: Optional[int] = None # 1-5 star rating
    aiConfidence: Optional[AIConfidence] = None
    translations: Optional[Dict[str, IcelandicTranslations]] = None


# --- Constants and Regex Patterns ---

KNOWN_BRANDS: Set[str] = set([
  'abercrombie', 'adidas', 'armani', 'balenciaga', 'burberry', 'calvin klein',
  'cartier', 'chanel', 'coach', 'dior', 'dolce & gabbana', 'fendi', 'gap',
  'gucci', 'h&m', 'hermès', 'hugo boss', 'lacoste', 'levi', 'louis vuitton',
  'mango', 'michael kors', 'nike', 'prada', 'puma', 'ralph lauren', 'rolex',
  'tiffany', 'tommy hilfiger', 'uniqlo', 'versace', 'zara', '&otherstories',
  'cos', 'mango', 'massimo dutti', 'pull & bear', 'bershka', 'stradivarius',
])

MATERIAL_PATTERNS = re.compile(r'\b(cotton|linen|polyester|leather|silk|wool|cashmere|denim|suede|velvet|satin|chiffon|nylon|spandex|elastane|viscose|rayon|acrylic|fleece|corduroy|tweed|knit|jersey)\b', re.IGNORECASE)
COLOR_PATTERNS = re.compile(r'\b(light|dark|pale|bright|deep)?\s?(gray|grey|white|black|blue|red|green|yellow|purple|brown|beige|navy|maroon|olive|teal|pink|orange|cream|tan|khaki|burgundy|charcoal|ivory|gold|silver|bronze|copper|turquoise|lavender|mint|coral|peach|rose|crimson|indigo|violet|magenta|cyan|lime|rust|mustard|emerald|sapphire|ruby)\b', re.IGNORECASE)
PATTERN_KEYWORDS = re.compile(r'\b(striped?|solid|floral|polka dot|checkered|plaid|geometric|paisley|animal print|zebra|leopard|houndstooth|argyle|chevron|abstract|tie-dye|camouflage)\b', re.IGNORECASE)
STYLE_ADJECTIVES = re.compile(r'\b(casual|formal|elegant|sporty|relaxed|fitted|oversized|slim|classic|modern|vintage|bohemian|minimalist|preppy|edgy|sophisticated|chic|trendy|business|athletic)\b', re.IGNORECASE)
SEASONAL_KEYWORDS = re.compile(r'\b(summer|winter|spring|fall|autumn|all-season)\b', re.IGNORECASE)
SUSTAINABILITY_KEYWORDS = re.compile(r'\b(sustainable|eco-friendly|organic|recycled|fair trade|ethically sourced|biodegradable|renewable|vegan|cruelty-free)\b', re.IGNORECASE)
CARE_INSTRUCTION_PATTERNS = re.compile(r'\b(machine wash cold|machine wash warm|hand wash only|dry clean only|do not dry clean|tumble dry low|tumble dry medium|do not tumble dry|line dry|lay flat to dry|hang to dry|iron on low heat|iron on medium heat|do not iron|steam only|cool iron if needed|do not bleach|non-chlorine bleach only|bleach when needed|professional dry clean|dry flat|reshape while damp)\b', re.IGNORECASE)

CONDITION_EXCELLENT = re.compile(r'\b(new with tags|brand new|never worn|mint condition|pristine|unworn|nwt|bnwt|tags attached)\b', re.IGNORECASE)
CONDITION_VERY_GOOD = re.compile(r'\b(like new|excellent condition|barely worn|hardly used|minimal wear|near mint|almost new|worn once)\b', re.IGNORECASE)
CONDITION_GOOD = re.compile(r'\b(good condition|gently used|light wear|some signs of use|lightly worn|normal wear)\b', re.IGNORECASE)
CONDITION_FAIR = re.compile(r'\b(used|wear and tear|visible signs|needs repair|stains|fading|pilling|minor damage)\b', re.IGNORECASE)
CONDITION_POOR = re.compile(r'\b(damaged|broken|heavily worn|for parts|restoration needed|major damage|torn|ripped)\b', re.IGNORECASE)

STOP_WORDS: Set[str] = set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'this', 'that', 'these',
  'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you',
  'your', 'he', 'she', 'his', 'her',
])

ICELANDIC_TRANSLATIONS: Dict[str, str] = {
  # Materials
  'Cotton': 'Bómull', 'Linen': 'Hör', 'Polyester': 'Pólýester', 'Leather': 'Leður',
  'Silk': 'Silki', 'Wool': 'Ull', 'Cashmere': 'Kasmír', 'Denim': 'Denim',
  'Suede': 'Súða', 'Velvet': 'Flauel', 'Satin': 'Satin', 'Chiffon': 'Chiffon',
  'Nylon': 'Nylon', 'Spandex': 'Spandex', 'Elastane': 'Elastan', 'Viscose': 'Viskósi',
  'Rayon': 'Rayon', 'Acrylic': 'Akrýl', 'Fleece': 'Fleece',

  # Colors
  'Gray': 'Grár', 'Grey': 'Grár', 'White': 'Hvítur', 'Black': 'Svartur',
  'Blue': 'Blár', 'Red': 'Rauður', 'Green': 'Grænn', 'Yellow': 'Gulur',
  'Purple': 'Fjólublár', 'Brown': 'Brúnn', 'Beige': 'Beige', 'Navy': 'Dökkblár',
  'Pink': 'Bleikur', 'Orange': 'Appelsínugulur', 'Light': 'Ljós', 'Dark': 'Dökk',
  'Pale': 'Fölur', 'Bright': 'Skær', 'Deep': 'Djúp', 'Cream': 'Krem', 'Tan': 'Brúnt',
  'Khaki': 'Kakí', 'Burgundy': 'Búrgúndí', 'Charcoal': 'Kolgrátt', 'Ivory': 'Fílabeinslitur',
  'Gold': 'Gull', 'Silver': 'Silfur', 'Bronze': 'Brons', 'Copper': 'Kopar',
  'Turquoise': 'Túrkís', 'Lavender': 'Lavender', 'Mint': 'Mintu', 'Coral': 'Kóral',
  'Peach': 'Ferskjulitur', 'Rose': 'Rósa', 'Crimson': 'Dökkrauður', 'Indigo': 'Indígó',
  'Violet': 'Fjólublár', 'Magenta': 'Magenta', 'Cyan': 'Blágrænn', 'Lime': 'Límónugrænn',
  'Rust': 'Ryð', 'Mustard': 'Sinnepsgulur', 'Emerald': 'Smaragdgrænn', 'Sapphire': 'Safírblár',
  'Ruby': 'Rúbin',

  # Patterns
  'Striped': 'Röndótt', 'Solid': 'Einfalt', 'Floral': 'Blómamynstur', 'Polka dot': 'Prikkað',
  'Checkered': 'Terningsmynstur', 'Plaid': 'Skosk mynstur', 'Geometric': 'Rúmfræðilegt',
  'Paisley': 'Paisley mynstur', 'Animal print': 'Dýramynstur', 'Zebra': 'Sebrastrengur',
  'Leopard': 'Hlébarðamynstur', 'Houndstooth': 'Hundatannmynstur', 'Argyle': 'Rúðumynstur',
  'Chevron': 'Sjónarhorn', 'Abstract': 'Óhlutbundið', 'Tie-dye': 'Blekmynd', 'Camouflage': 'Felulitir',

  # Styles
  'Casual': 'Óformlegt', 'Formal': 'Formlegt', 'Elegant': 'Glæsilegt', 'Sporty': 'Íþrótta',
  'Relaxed': 'Afslappaður', 'Fitted': 'Þröngt', 'Oversized': 'Stórt', 'Slim': 'Mjótt',
  'Classic': 'Klassískt', 'Modern': 'Nútímalegt', 'Vintage': 'Sígilt', 'Bohemian': 'Bóhem',
  'Minimalist': 'Lágmarks', 'Preppy': 'Fínlegt', 'Edgy': 'Skörp', 'Sophisticated': 'Fágað',
  'Chic': 'Smart', 'Trendy': 'Tísku', 'Business': 'Viðskipta', 'Athletic': 'Íþrótta',

  # Seasons
  'Summer': 'Sumar', 'Winter': 'Vetur', 'Spring': 'Vor', 'Fall': 'Haust', 'Autumn': 'Haust',
  'All-season': 'Heilsárs',

  # Care Instructions
  'Machine wash cold': 'Þvottavél í köldu vatni', 'Machine wash warm': 'Þvottavél í hlýju vatni',
  'Hand wash only': 'Aðeins handþvottur', 'Dry clean only': 'Aðeins efnaþvottur',
  'Do not dry clean': 'Ekki efnaþvottur', 'Tumble dry low': 'Þurrktumbla lágt',
  'Tumble dry medium': 'Þurrktumbla miðlungs', 'Do not tumble dry': 'Ekki þurrktumbla',
  'Line dry': 'Hengja til þerris', 'Lay flat to dry': 'Leggja flatt til þerris',
  'Hang to dry': 'Hengja til þerris', 'Iron on low heat': 'Strauja á lágum hita',
  'Iron on medium heat': 'Strauja á miðlungs hita', 'Do not iron': 'Ekki strauja',
  'Steam only': 'Aðeins gufa', 'Cool iron if needed': 'Kalt straujárn ef þörf krefur',
  'Do not bleach': 'Ekki bleikja', 'Non-chlorine bleach only': 'Aðeins bleikja án klórs',
  'Bleach when needed': 'Bleikja þegar þörf krefur', 'Professional dry clean': 'Fagleg efnaþvott',
  'Dry flat': 'Þurrka flatt', 'Reshape while damp': 'Móta á meðan rakt',
}


CATEGORY_MAP: Dict[str, Dict[str, str]] = {
  # Clothing
  'blouse': {'primary': 'Clothing', 'secondary': 'Women's Clothing', 'tertiary': 'Tops'},
  'shirt': {'primary': 'Clothing', 'secondary': 'Men's Clothing', 'tertiary': 'Tops'},
  'dress': {'primary': 'Clothing', 'secondary': 'Women's Clothing', 'tertiary': 'Dresses'},
  'pants': {'primary': 'Clothing', 'secondary': 'Bottoms', 'tertiary': 'Pants'},
  'jeans': {'primary': 'Clothing', 'secondary': 'Bottoms', 'tertiary': 'Jeans'},
  'skirt': {'primary': 'Clothing', 'secondary': 'Women's Clothing', 'tertiary': 'Skirts'},
  'jacket': {'primary': 'Clothing', 'secondary': 'Outerwear', 'tertiary': 'Jackets'},
  'coat': {'primary': 'Clothing', 'secondary': 'Outerwear', 'tertiary': 'Coats'},
  'sweater': {'primary': 'Clothing', 'secondary': 'Tops', 'tertiary': 'Sweaters'},
  't-shirt': {'primary': 'Clothing', 'secondary': 'Tops', 'tertiary': 'T-Shirts'},

  # Footwear
  'shoes': {'primary': 'Footwear', 'secondary': 'Casual Shoes', 'tertiary': 'General'},
  'boots': {'primary': 'Footwear', 'secondary': 'Boots', 'tertiary': 'General'},
  'sneakers': {'primary': 'Footwear', 'secondary': 'Athletic', 'tertiary': 'Sneakers'},
  'sandals': {'primary': 'Footwear', 'secondary': 'Casual Shoes', 'tertiary': 'Sandals'},

  # Accessories
  'bag': {'primary': 'Accessories', 'secondary': 'Bags', 'tertiary': 'Handbags'},
  'watch': {'primary': 'Accessories', 'secondary': 'Jewelry', 'tertiary': 'Watches'},
  'jewelry': {'primary': 'Accessories', 'secondary': 'Jewelry', 'tertiary': 'General'},
  'scarf': {'primary': 'Accessories', 'secondary': 'Accessories', 'tertiary': 'Scarves'},
  'belt': {'primary': 'Accessories', 'secondary': 'Accessories', 'tertiary': 'Belts'},
}


class AIAttributeExtractor:
    """
    Extracts structured product attributes from AI-generated descriptions or
    uses regex-based extraction as a fallback.
    """

    def __init__(self, use_ai_extraction: bool = False):
        self.use_ai_extraction = use_ai_extraction

    def _capitalize_first_letter(self, text: str) -> str:
        return text.split(' ')[0].capitalize() + ' '.join(text.split(' ')[1:]) if ' ' in text else text.capitalize()

    def _extract_brand(self, title: str, description: str) -> Dict[str, Any]:
        title_lower = title.lower()
        
        first_word = title_lower.split()[0] if title_lower else ""
        if first_word in KNOWN_BRANDS:
            return {'brand': title.split()[0], 'confidence': 0.95} # Preserve original casing

        for brand in KNOWN_BRANDS:
            if brand in title_lower:
                return {'brand': self._capitalize_first_letter(brand), 'confidence': 0.90} # Capitalize brand name

        capitalized_match = re.search(r'\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b', title)
        if capitalized_match:
            return {'brand': capitalized_match.group(1), 'confidence': 0.70}

        return {'brand': None, 'confidence': 0.50}

    def _extract_material(self, text: str) -> Dict[str, Any]:
        matches = MATERIAL_PATTERNS.findall(text)
        if matches:
            material = matches[0].lower()
            percentage_pattern = re.compile(r'(\d+)%\s*' + re.escape(material), re.IGNORECASE)
            if percentage_pattern.search(text):
                return {'material': self._capitalize_first_letter(material), 'confidence': 0.95}
            return {'material': self._capitalize_first_letter(material), 'confidence': 0.90}
        return {'material': None, 'confidence': 0.50}

    def _extract_colors(self, text: str) -> Dict[str, Any]:
        matches = COLOR_PATTERNS.findall(text)
        if matches:
            color_set = set()
            for match_tuple in matches:
                full_match = ' '.join(filter(None, match_tuple)).strip() # Reconstruct multi-word color
                color_set.add(self._capitalize_first_letter(full_match))
            return {'colors': list(color_set), 'confidence': 0.85}
        return {'colors': [], 'confidence': 0.50}

    def _extract_pattern(self, title: str, description: str) -> Dict[str, Any]:
        title_match = PATTERN_KEYWORDS.search(title)
        if title_match:
            return {'pattern': self._capitalize_first_letter(title_match.group(0)), 'confidence': 0.95}

        desc_match = PATTERN_KEYWORDS.search(description)
        if desc_match:
            return {'pattern': self._capitalize_first_letter(desc_match.group(0)), 'confidence': 0.85}
        return {'pattern': None, 'confidence': 0.50}

    def _extract_care_instructions(self, text: str) -> Dict[str, Any]:
        matches = CARE_INSTRUCTION_PATTERNS.findall(text)
        if matches:
            instruction_set = set()
            for match_str in matches:
                instruction_set.add(self._capitalize_first_letter(match_str))
            return {'careInstructions': list(instruction_set), 'confidence': 0.90}
        return {'careInstructions': [], 'confidence': 0.50}

    def _extract_condition_rating(self, text: str) -> Dict[str, Any]:
        if CONDITION_EXCELLENT.search(text):
            return {'conditionRating': 5, 'confidence': 0.95}
        if CONDITION_VERY_GOOD.search(text):
            return {'conditionRating': 4, 'confidence': 0.90}
        if CONDITION_GOOD.search(text):
            return {'conditionRating': 3, 'confidence': 0.85}
        if CONDITION_FAIR.search(text):
            return {'conditionRating': 2, 'confidence': 0.80}
        if CONDITION_POOR.search(text):
            return {'conditionRating': 1, 'confidence': 0.85}
        return {'conditionRating': 3, 'confidence': 0.50} # Default

    def _extract_style_and_sustainability(self, text: str) -> Dict[str, Any]:
        style_matches = STYLE_ADJECTIVES.findall(text)
        seasonal_matches = SEASONAL_KEYWORDS.findall(text)
        sustainability_matches = SUSTAINABILITY_KEYWORDS.findall(text)

        style: List[str] = []

        if style_matches:
            style.extend([self._capitalize_first_letter(s) for s in style_matches])

        if seasonal_matches:
            style.extend([self._capitalize_first_letter(s) for s in seasonal_matches])

        unique_style = list(set(style))

        sustainability = [self._capitalize_first_letter(s) for s in sustainability_matches]
        unique_sustainability = list(set(sustainability))

        confidence = 0.85 if unique_style or unique_sustainability else 0.50

        return {'style': unique_style, 'sustainability': unique_sustainability, 'confidence': confidence}

    def _extract_keywords(self, params: Dict[str, Any]) -> Dict[str, Any]:
        keywords = set()

        if params.get('brand'): keywords.add(params['brand'].lower())
        if params.get('material'): keywords.add(params['material'].lower())
        if params.get('pattern'): keywords.add(params['pattern'].lower())
        if params.get('colors'):
            for color in params['colors']: keywords.add(color.lower())
        if params.get('style'):
            for s in params['style']: keywords.add(s.lower())
        if params.get('sustainability'):
            for tag in params['sustainability']: keywords.add(tag.lower())

        words = re.findall(r'\b\w+\b', params['description'].lower())
        for word in words:
            if len(word) > 3 and word not in STOP_WORDS:
                keywords.add(word)

        title_words = re.findall(r'\b\w+\b', params['title'].lower())
        for word in title_words:
            if len(word) > 3 and word not in STOP_WORDS:
                keywords.add(word)

        keyword_array = list(keywords)[:20]

        return {'keywords': keyword_array, 'confidence': 0.85 if keyword_array else 0.50}

    def _extract_category(self, params: Dict[str, Any]) -> Dict[str, Any]:
        title_lower = params['title'].lower()
        description_lower = params['description'].lower()

        for keyword, category_info in CATEGORY_MAP.items():
            if keyword in title_lower or keyword in description_lower:
                return {
                    'category': CategoryPath(
                        primary=category_info['primary'],
                        secondary=category_info['secondary'],
                        tertiary=category_info['tertiary'],
                        path=f"{category_info['primary']} > {category_info['secondary']} > {category_info['tertiary']}"
                    ),
                    'confidence': 0.90 if keyword in title_lower else 0.80
                }
        return {
            'category': CategoryPath(
                primary='General', secondary='Miscellaneous', tertiary='Uncategorized',
                path='General > Miscellaneous > Uncategorized'
            ),
            'confidence': 0.60
        }

    def _translate_to_icelandic_dict_based(self, result: ExtractionResult) -> IcelandicTranslations:
        translations = IcelandicTranslations()

        if result.material:
            translations.material = ICELANDIC_TRANSLATIONS.get(result.material, result.material)

        if result.colors:
            translated_colors = []
            for color in result.colors:
                words = color.split(' ')
                translated_words = [ICELANDIC_TRANSLATIONS.get(word, word) for word in words]
                translated_colors.append(' '.join(translated_words))
            translations.colors = translated_colors

        if result.pattern:
            translations.pattern = ICELANDIC_TRANSLATIONS.get(result.pattern, result.pattern)

        if result.style:
            translations.style = [ICELANDIC_TRANSLATIONS.get(s, s) for s in result.style]

        if result.careInstructions:
            translations.careInstructions = [ICELANDIC_TRANSLATIONS.get(c, c) for c in result.careInstructions]
        
        return translations

    def _map_condition_to_rating(self, condition: str) -> int:
        ratings: Dict[str, int] = {
            'new_with_tags': 5, 'like_new': 4, 'very_good': 4, 'good': 3, 'fair': 2
        }
        return ratings.get(condition, 3) # Default to 3 (good)


    def _extract_from_ai(
        self,
        mistral_result: MistralPixtralAnalysisResult,
        product_name: str,
        bilingual_description: MultilingualProductDescription
    ) -> ExtractionResult:
        """
        Extracts attributes directly from Mistral Pixtral AI results.
        """
        category_parts = (mistral_result.category or 'General/General/Items').split('/')
        primary = category_parts[0]
        secondary = category_parts[1] if len(category_parts) > 1 else 'General'
        tertiary = category_parts[2] if len(category_parts) > 2 else 'Items'

        # Map AI condition to 1-5 rating scale
        condition_rating = self._map_condition_to_rating(mistral_result.condition)

        # AI confidence scores
        ai_confidence = AIConfidence(
            brand=mistral_result.aiConfidence.brand if mistral_result.aiConfidence else (0.8 if mistral_result.brand else 0.0),
            material=mistral_result.aiConfidence.material if mistral_result.aiConfidence else (0.8 if mistral_result.material else 0.0),
            colors=mistral_result.aiConfidence.colors if mistral_result.aiConfidence else 0.8,
            pattern=0.8 if mistral_result.pattern else 0.0,
            style=0.8 if mistral_result.style and len(mistral_result.style) > 0 else 0.0,
            keywords=mistral_result.aiConfidence.overall if mistral_result.aiConfidence else 0.85,
            category=mistral_result.aiConfidence.category if mistral_result.aiConfidence else 0.85,
            careInstructions=0.8 if mistral_result.careInstructions and len(mistral_result.careInstructions) > 0 else 0.0,
            conditionRating=mistral_result.aiConfidence.condition if mistral_result.aiConfidence else 0.85
        )

        icelandic_translations_dict_based = self._translate_to_icelandic_dict_based(ExtractionResult(
            brand=mistral_result.brand,
            material=mistral_result.material,
            colors=mistral_result.colors,
            pattern=mistral_result.pattern,
            style=mistral_result.style,
            careInstructions=mistral_result.careInstructions
        ))


        return ExtractionResult(
            brand=mistral_result.brand,
            material=mistral_result.material,
            colors=mistral_result.colors,
            pattern=mistral_result.pattern,
            style=mistral_result.style,
            sustainability=[], # Not directly provided by Mistral in current schema
            keywords=mistral_result.keywords,
            category=CategoryPath(
                primary=primary,
                secondary=secondary,
                tertiary=tertiary,
                path=f"{primary} > {secondary} > {tertiary}"
            ),
            careInstructions=mistral_result.careInstructions,
            conditionRating=condition_rating,
            aiConfidence=ai_confidence,
            translations={
                "is": icelandic_translations_dict_based
            }
        )


    def extract_attributes(
        self,
        product_name: str = Field(..., description="The name of the product."),
        bilingual_description: ProductDescription = Field(..., description="Product description in English."), # Only English part is used for regex extraction
        mistral_result: Optional[MistralPixtralAnalysisResult] = Field(None, description="Optional AI analysis result from Mistral Pixtral for AI-native extraction.")
    ) -> ExtractionResult:
        """
        Extracts structured product attributes from AI-generated descriptions or
        uses regex-based extraction as a fallback.
        """
        if self.use_ai_extraction and mistral_result:
            # Need to pass an empty MultilingualProductDescription as placeholder if only English is used
            return self._extract_from_ai(mistral_result, product_name, MultilingualProductDescription(en=bilingual_description, is_=ProductDescription(short="", long="", category="", colors=[], condition="good", keywords=[])))

        en_desc = bilingual_description
        description_en = en_desc.long
        short_en = en_desc.short
        title = product_name

        full_text = f"{title} {short_en} {description_en}"

        brand_res = self._extract_brand(title, full_text)
        material_res = self._extract_material(full_text)
        colors_res = self._extract_colors(full_text)
        pattern_res = self._extract_pattern(title, full_text)
        style_sustain_res = self._extract_style_and_sustainability(full_text)
        care_instructions_res = self._extract_care_instructions(full_text)
        condition_rating_res = self._extract_condition_rating(full_text)
        
        keywords_res = self._extract_keywords({
            'title': title,
            'description': full_text,
            'brand': brand_res['brand'],
            'material': material_res['material'],
            'colors': colors_res['colors'],
            'pattern': pattern_res['pattern'],
            'style': style_sustain_res['style'],
            'sustainability': style_sustain_res['sustainability'],
        })

        category_res = self._extract_category({
            'title': title,
            'description': full_text,
            'material': material_res['material'],
            'pattern': pattern_res['pattern'],
            'style': style_sustain_res['style'],
        })

        ai_confidence = AIConfidence(
            brand=brand_res['confidence'],
            material=material_res['confidence'],
            colors=colors_res['confidence'],
            pattern=pattern_res['confidence'],
            style=style_sustain_res['confidence'],
            keywords=keywords_res['confidence'],
            category=category_res['confidence'],
            careInstructions=care_instructions_res['confidence'],
            conditionRating=condition_rating_res['confidence'],
        )

        base_result = ExtractionResult(
            brand=brand_res['brand'],
            material=material_res['material'],
            colors=colors_res['colors'],
            pattern=pattern_res['pattern'],
            style=style_sustain_res['style'],
            sustainability=style_sustain_res['sustainability'],
            keywords=keywords_res['keywords'],
            category=category_res['category'],
            careInstructions=care_instructions_res['careInstructions'],
            conditionRating=condition_rating_res['conditionRating'],
            aiConfidence=ai_confidence,
        )

        icelandic_translations = self._translate_to_icelandic_dict_based(base_result)

        return ExtractionResult(
            **base_result.model_dump(),
            translations={"is": icelandic_translations}
        )
