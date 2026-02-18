import json
import re
from typing import Literal, Optional, List, Dict, Any, get_args

import boto3
from pydantic import BaseModel, Field

# --- Input Models ---
class RekognitionHints(BaseModel):
    labels: Optional[List[str]] = None
    detectedBrand: Optional[str] = None
    detectedSize: Optional[str] = None
    category: Optional[str] = None
    colors: Optional[List[str]] = None

# --- Output Nested Models ---
class AiConfidence(BaseModel):
    brand: Optional[float] = None
    size: Optional[float] = None
    material: Optional[float] = None
    condition: float = Field(..., description="Confidence for product condition.")
    colors: float = Field(..., description="Confidence for detected colors.")
    category: float = Field(..., description="Confidence for product category.")
    overall: float = Field(..., description="Overall AI confidence.")

class PricingHints(BaseModel):
    rarity: Literal["common", "uncommon", "rare", "vintage"] = Field("common")
    craftsmanship: Literal["poor", "fair", "good", "excellent"] = Field("fair")
    marketDemand: Literal["low", "medium", "high"] = Field("medium")
    estimatedAgeYears: Optional[int] = None
    brandTier: Literal["premium", "luxury", "designer", "mass-market", "unknown"] = Field("unknown")

class QualityHints(BaseModel):
    materialQuality: Literal["poor", "fair", "good", "excellent"] = Field("fair")
    constructionQuality: Literal["poor", "fair", "good", "excellent"] = Field("fair")
    authenticity: Literal["questionable", "likely", "confirmed"] = Field("likely")
    visibleDefects: List[str] = Field([])
    wearPattern: Literal["minimal", "light", "moderate", "heavy"] = Field("light")

# --- Main Output Model ---
class MistralPixtralAnalysisResult(BaseModel):
    brand: Optional[str] = None
    size: Optional[str] = None
    material: Optional[str] = None

    condition: Literal["new_with_tags", "like_new", "very_good", "good", "fair"]
    category: str
    colors: List[str]
    keywords: List[str]

    approved: bool
    moderationReason: Optional[str] = None

    short_en: str
    long_en: str
    stylingTip_en: Optional[str] = None

    short_is: str
    long_is: str
    stylingTip_is: Optional[str] = None

    aiConfidence: Optional[AiConfidence] = None

    pattern: Optional[str] = None
    style: Optional[List[str]] = None
    season: Optional[Literal["spring", "summer", "fall", "winter", "all-season"]] = None
    occasion: Optional[List[str]] = None
    careInstructions: Optional[List[str]] = None

    pricingHints: Optional[PricingHints] = None
    qualityHints: Optional[QualityHints] = None

    # Post-processing to ensure valid conditions
    def model_post_init(self, __context: Any) -> None:
        valid_conditions = ["new_with_tags", "like_new", "very_good", "good", "fair"]
        if self.condition not in valid_conditions:
            print(f"Warning: Invalid condition '{self.condition}', defaulting to 'very_good'")
            self.condition = "very_good"
        # Ensure confidence scores have defaults if not provided by model
        if not self.aiConfidence:
            self.aiConfidence = AiConfidence(
                brand=0.7 if self.brand else 0.0,
                size=0.7 if self.size else 0.0,
                material=0.7 if self.material else 0.0,
                condition=0.8,
                colors=0.8 if self.colors and len(self.colors) > 0 else 0.5,
                category=0.8,
                overall=0.75
            )
        # Set defaults for pricing hints if missing
        if not self.pricingHints:
            self.pricingHints = PricingHints()
        # Set defaults for quality hints if missing
        if not self.qualityHints:
            self.qualityHints = QualityHints()


class MistralPixtralAnalyzer:
    """
    Agent for comprehensive image analysis using Mistral Pixtral Large on AWS Bedrock.
    """
    def __init__(self, region_name: str = 'us-east-1'):
        self.bedrock_client = boto3.client('bedrock-runtime', region_name=region_name)
        self.model_id = 'us.mistral.pixtral-large-2502-v1:0'

    def analyze_with_mistral_pixtral(
        self,
        processed_image_buffer_b64: str = Field(..., description="Base64 encoded processed image buffer (PNG)."),
        product_name: Optional[str] = Field(None, description="Optional name of the product for context."),
        rekognition_hints: Optional[RekognitionHints] = Field(None, description="Hints from Rekognition analysis.")
    ) -> MistralPixtralAnalysisResult:
        """
        Analyzes an image using Mistral Pixtral Large to extract product attributes,
        generate descriptions, and provide pricing/quality hints.
        """
        system_prompt = "You are an expert fashion curator and copywriter for Hringekjan.is, a premium sustainable marketplace in Iceland. You provide elegant, sophisticated, timeless product descriptions that emphasize quality and sustainability.

"

        hints_text = ""
        if rekognition_hints and rekognition_hints.labels:
            hints_text = "

**Context from image analysis:**
"
            hints_text += f"{', '.join(rekognition_hints.labels)}"
            if rekognition_hints.detectedBrand:
                hints_text += f"
Possible brand: {rekognition_hints.detectedBrand}"
            if rekognition_hints.detectedSize:
                hints_text += f"
Possible size: {rekognition_hints.detectedSize}"
            if rekognition_hints.category:
                hints_text += f"
Category hint: {rekognition_hints.category}"
            if rekognition_hints.colors:
                hints_text += f"
Color palette: {', '.join(rekognition_hints.colors)}"

        task_prompt = ""
        if rekognition_hints and rekognition_hints.labels:
            task_prompt = f"""Analyze this luxury second-hand fashion item for Hringekjan.is marketplace.{f' Product name: "{product_name}"' if product_name else ''}

**🔍 DETECTED FEATURES (PRIMARY SOURCE - USE THESE AS FOUNDATION):**
Our computer vision analysis has already identified these features. Base your description primarily on these detected attributes:

{f'• Detected visual elements: {", ".join(rekognition_hints.labels)}' if rekognition_hints.labels else ''}{
  f'
• Brand identified: {rekognition_hints.detectedBrand}' if rekognition_hints.detectedBrand else ''
}{
  f'
• Size detected: {rekognition_hints.detectedSize}' if rekognition_hints.detectedSize else ''
}{
  f'
• Category classification: {rekognition_hints.category}' if rekognition_hints.category else ''
}{
  f'
• Color palette: {", ".join(rekognition_hints.colors)}' if rekognition_hints.colors else ''
}

**IMPORTANT:** These detected features are the PRIMARY BASIS for your description. Use visual analysis of the image to enhance and refine these facts, NOT to replace them.

**TASK 1: VERIFY & EXTRACT FROM IMAGE**
Examine the image to verify the detected features above and extract additional details from visible tags/labels:
- Confirm or correct the detected brand (look for brand tags, labels, logos, embroidery)
- Verify or refine the detected size (from size tag: "M", "EU 38", "US 8", etc.)
- Add material composition if visible (from care label: "100% Cotton", "Leather", etc.)
- Validate the detected colors and category

**TASK 2: ASSESS PRODUCT CONDITION & STYLE**
- Condition: Based on visible wear, choose ONE: new_with_tags | like_new | very_good | good | fair
- Style keywords: Generate 5-7 keywords combining detected features + visual style (e.g., ["silk", "elegant", "vintage", "minimalist"])
- Content check: Is this appropriate for a family-friendly marketplace? (yes/no)

**TASK 3: GENERATE ENGLISH DESCRIPTIONS (based on detected features)**
Create premium marketing content that INCORPORATES the detected features above:
- Elegant product name using detected brand/category/features (e.g., "Vintage Silk Blouse" if silk + blouse detected)
- 3-sentence marketing description highlighting detected materials, colors, category (timeless, sophisticated, sustainable tone)
- 1-sentence styling tip referencing detected features and colors

**TASK 4: TRANSLATE TO ICELANDIC**
Translate the same content naturally to Icelandic:
- Elegant product name in Icelandic (maintaining detected feature references)
- Same 3-sentence description in natural Icelandic (not literal translation)
- Same styling tip in Icelandic"""
        else:
            task_prompt = f"""Analyze this luxury second-hand fashion item for Hringekjan.is marketplace.{f' Product name: "{product_name}"' if product_name else ''}

**TASK 1: EXTRACT FROM IMAGE (read visible tags/labels/logos)**
Carefully examine the image for any visible text on tags, labels, or logos:
- Brand name (from brand tags, labels, logos, or embroidery)
- Size (from size tag: "M", "EU 38", "US 8", etc.)
- Material composition (from care label: "100% Cotton", "Leather", etc.)

**TASK 2: ASSESS PRODUCT**
- Condition: Based on visible wear, choose ONE: new_with_tags | like_new | very_good | good | fair
- Category: Specific category like "apparel/jacket", "accessories/bag", "apparel/dress"
- Colors: Array of main colors visible in the image
- Style keywords: 5-7 keywords (e.g., ["elegant", "vintage", "minimalist", "leather"])
- Content check: Is this appropriate for a family-friendly marketplace? (yes/no)

**TASK 3: GENERATE ENGLISH DESCRIPTIONS**
Create premium marketing content in English:
- Elegant product name (specific, e.g., "Tailored Silk Blouse" NOT just "Shirt")
- 3-sentence marketing description (timeless, sophisticated, sustainable tone)
- 1-sentence styling tip (how to wear/style this item)

**TASK 4: TRANSLATE TO ICELANDIC**
Translate the same content naturally to Icelandic:
- Elegant product name in Icelandic
- Same 3-sentence description in natural Icelandic (not literal translation)
- Same styling tip in Icelandic

**TASK 5: COMPREHENSIVE ATTRIBUTE EXTRACTION WITH CONFIDENCE SCORES**
For each attribute below, provide assessment WITH confidence score (0.0-1.0):

5.1 **Additional Attributes (AI-native extraction, no hardcoding):**
- Pattern: striped, solid, floral, plaid, geometric, animal print, checkered, polka dot, etc. (null if no clear pattern)
- Style: casual, formal, elegant, sporty, vintage, bohemian, minimalist, preppy, etc. (array, can be multiple)
- Season: spring, summer, fall, winter, or all-season
- Occasion: work, party, casual, formal, athletic, evening, beach, etc. (array, can be multiple)
- Care Instructions: visible on care labels (e.g., "machine wash cold", "dry clean only", "hand wash", "line dry", etc.)

5.2 **Pricing Intelligence Hints (for market positioning):**
Analyze visual indicators to help with pricing:
- Rarity: common (mass-produced), uncommon (limited production), rare (hard to find), vintage (20+ years old)
- Craftsmanship: poor (mass-produced low quality), fair (standard), good (well-made), excellent (artisan/handmade)
- Market Demand: low, medium, high (based on desirability, trend relevance, brand popularity from visual cues)
- Estimated Age: approximate age in years if determinable from wear/style (e.g., 2, 5, 15, null if unsure)
- Brand Tier: premium (Hermès, Chanel, Louis Vuitton), luxury (Armani, Versace, Gucci), designer (Zara, Mango, COS), mass-market (H&M, Uniqlo, Forever 21), unknown

5.3 **Quality Assessment Hints (visual quality indicators):**
Evaluate based on what you can SEE in the image:
- Material Quality: poor, fair, good, excellent (visual appearance, texture, finish)
- Construction Quality: poor, fair, good, excellent (stitching, seams, finishing, durability indicators)
- Authenticity: questionable (possible counterfeit signs), likely (appears genuine), confirmed (verified markers visible)
- Visible Defects: list ANY visible damage, stains, tears, wear spots, fading, pilling, loose threads, etc. (empty array if none)
- Wear Pattern: minimal (like new), light (barely worn), moderate (normal use signs), heavy (significant wear)

**CRITICAL:** Base ALL assessments on VISUAL EVIDENCE from the image only. Do not speculate beyond what is visible."""

        output_format_instruction = """
**OUTPUT FORMAT:**
Return ONLY valid JSON (no markdown, no explanation, no code blocks):
{
  "brand": "brand name if visible, otherwise null",
  "size": "size if visible, otherwise null",
  "material": "material if visible, otherwise null",
  "condition": "condition_value",
  "category": "specific/category",
  "colors": ["color1", "color2"],
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "approved": true,
  "short_en": "Elegant English Name",
  "long_en": "Three-sentence premium English description emphasizing quality and sustainability.",
  "stylingTip_en": "Styling tip in English.",
  "short_is": "Elegant Icelandic Name",
  "long_is": "Þrjár setningar á íslensku um gæði og sjálfbærni.",
  "stylingTip_is": "Stílráð á íslensku.",
  "aiConfidence": {
    "brand": 0.9,
    "size": 0.8,
    "material": 0.95,
    "condition": 0.85,
    "colors": 0.9,
    "category": 0.92,
    "overall": 0.88
  },
  "pattern": "striped or null",
  "style": ["casual", "summer"],
  "season": "summer or all-season",
  "occasion": ["casual", "work"],
  "careInstructions": ["machine wash cold", "line dry"],
  "pricingHints": {
    "rarity": "common",
    "craftsmanship": "good",
    "marketDemand": "medium",
    "estimatedAgeYears": 2,
    "brandTier": "designer"
  },
  "qualityHints": {
    "materialQuality": "good",
    "constructionQuality": "good",
    "authenticity": "likely",
    "visibleDefects": [],
    "wearPattern": "light"
  }
}"""
        request_body = {
            "messages": [{
                "role": 'user',
                "content": [
                    {
                        "type": 'image_url',
                        "image_url": {
                            "url": f'data:image/png;base64,{processed_image_buffer_b64}'
                        }
                    },
                    {
                        "type": 'text',
                        "text": system_prompt + task_prompt + output_format_instruction
                    }
                ]
            }]
        }

        print('Invoking Mistral Pixtral Large for comprehensive analysis...', {
            "productName": productName,
            "hasRekognitionHints": bool(rekognition_hints),
            "hintsLabels": len(rekognition_hints.labels) if rekognition_hints and rekognition_hints.labels else 0,
            "modelId": self.model_id,
        })

        response = self.bedrock_client.invoke_model(
            modelId=self.model_id,
            contentType='application/json',
            accept='application/json',
            body=json.dumps(request_body)
        )

        response_body = json.loads(response['body'].read().decode('utf-8'))

        print('Bedrock response structure:', {
            "hasOutput": 'output' in response_body,
            "hasChoices": 'choices' in response_body,
            "hasMessage": 'message' in response_body,
            "responseKeys": list(response_body.keys()),
            "firstChoiceKeys": list(response_body.get('choices', [{}])[0].keys()) if response_body.get('choices') else []
        })

        # Try different response formats (Mistral vs Nova)
        analysis_text = (
            response_body.get('output', {}).get('message', {}).get('content', [{}])[0].get('text', '') or  # Nova format
            response_body.get('choices', [{}])[0].get('message', {}).get('content', '') or        # Mistral format, direct content string
            response_body.get('content', [{}])[0].get('text', '') or                    # Alternative format
            ''
        )

        if not analysis_text:
            print(f'Unable to extract text from response: {json.dumps(response_body, indent=2)[:500]}')
            raise ValueError('No response from Mistral Pixtral Large')

        # Extract JSON from response (handle markdown code blocks)
        json_text = analysis_text
        json_match = re.search(r'```json\s*(\{[\s\S]*?\})\s*```', analysis_text) or re.search(r'(\{[\s\S]*\})', analysis_text)
        if json_match:
            json_text = json_match.group(1) if json_match.group(1) else json_match.group(0)

        result_data = json.loads(json_text)

        # Validate required fields (simplified for Pydantic)
        if not result_data.get('short_en') or not result_data.get('long_en') or 
           not result_data.get('short_is') or not result_data.get('long_is'):
            raise ValueError('Mistral Pixtral Large response missing required description fields')

        # Map optional "null" string values to None
        for key in ['brand', 'size', 'material', 'pattern', 'season']:
            if result_data.get(key) == "null":
                result_data[key] = None

        # Convert to list if comma-separated string for colors, keywords, style, occasion, careInstructions
        for key in ['colors', 'keywords', 'style', 'occasion', 'careInstructions']:
            if isinstance(result_data.get(key), str):
                result_data[key] = [item.strip() for item in result_data[key].split(',')]
            elif result_data.get(key) is None:
                result_data[key] = [] if key in ['colors', 'keywords', 'visibleDefects'] else None # Default to empty list for some fields

        # Pydantic will handle further validation and defaults
        return MistralPixtralAnalysisResult(**result_data)
