import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'eu-west-1' });

export interface NovaProAnalysisResult {
  // Extracted from image (OCR from tags/labels)
  brand?: string;
  size?: string;
  material?: string;

  // AI assessment
  condition: 'new_with_tags' | 'like_new' | 'very_good' | 'good' | 'fair';
  category: string;
  colors: string[];
  keywords: string[];

  // Content safety
  approved: boolean;
  moderationReason?: string;

  // English descriptions
  short_en: string;
  long_en: string;
  stylingTip_en?: string;

  // Icelandic descriptions (translated)
  short_is: string;
  long_is: string;
  stylingTip_is?: string;
}

/**
 * Single Nova Pro call to:
 * 1. Extract brand/size/material from image tags (OCR)
 * 2. Assess product condition
 * 3. Generate premium English description
 * 4. Translate to Icelandic
 * 5. Check content appropriateness
 *
 * Replaces: Nova Lite + GPT-OSS-120B (2 calls → 1 call)
 * Cost: ~$0.06 per image (vs $0.10 for 2 calls)
 * Time: 2-3s (vs 3s sequential)
 */
export async function analyzeWithNovaPro(
  processedImageBuffer: Buffer,
  productName?: string,
  rekognitionHints?: {
    labels?: string[];
    detectedBrand?: string;
    detectedSize?: string;
    category?: string;
    colors?: string[];
  }
): Promise<NovaProAnalysisResult> {

  const base64Image = processedImageBuffer.toString('base64');

  // Build context from Rekognition
  const hintsText = rekognitionHints?.labels
    ? `\n\n**Context from image analysis:**
${rekognitionHints.labels.join(', ')}${
  rekognitionHints.detectedBrand ? `\nPossible brand: ${rekognitionHints.detectedBrand}` : ''
}${
  rekognitionHints.detectedSize ? `\nPossible size: ${rekognitionHints.detectedSize}` : ''
}${
  rekognitionHints.category ? `\nCategory hint: ${rekognitionHints.category}` : ''
}`
    : '';

  const requestBody = {
    max_tokens: 2000,
    temperature: 0.7,
    system: [{
      text: "You are an expert fashion curator and copywriter for Hringekjan.is, a premium sustainable marketplace in Iceland. You provide elegant, sophisticated, timeless product descriptions that emphasize quality and sustainability."
    }],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: base64Image
          }
        },
        {
          type: 'text',
          text: `Analyze this luxury second-hand fashion item for Hringekjan.is marketplace.${productName ? ` Product name: "${productName}"` : ''}${hintsText}

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
  "stylingTip_is": "Stílráð á íslensku."
}`
        }
      ]
    }]
  };

  console.log('Invoking Nova Pro for comprehensive analysis...', {
    productName,
    hasRekognitionHints: !!rekognitionHints,
    hintsLabels: rekognitionHints?.labels?.length || 0
  });

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: 'amazon.nova-pro-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody)
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const analysisText = responseBody.output?.message?.content?.[0]?.text || '';

  if (!analysisText) {
    throw new Error('No response from Nova Pro');
  }

  // Extract JSON from response (handle markdown code blocks)
  let jsonText = analysisText;
  const jsonMatch = analysisText.match(/```json\s*(\{[\s\S]*?\})\s*```/) || analysisText.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    jsonText = jsonMatch[1] || jsonMatch[0];
  }

  const result = JSON.parse(jsonText);

  // Validate required fields
  if (!result.short_en || !result.long_en || !result.short_is || !result.long_is) {
    throw new Error('Nova Pro response missing required description fields');
  }

  // Ensure condition is valid
  const validConditions = ['new_with_tags', 'like_new', 'very_good', 'good', 'fair'];
  if (!validConditions.includes(result.condition)) {
    console.warn(`Invalid condition "${result.condition}", defaulting to "very_good"`);
    result.condition = 'very_good';
  }

  console.log('Nova Pro analysis complete:', {
    brand: result.brand || 'not detected',
    size: result.size || 'not detected',
    material: result.material || 'not detected',
    condition: result.condition,
    category: result.category,
    approved: result.approved,
    hasEnglish: !!result.short_en,
    hasIcelandic: !!result.short_is
  });

  return {
    brand: result.brand || undefined,
    size: result.size || undefined,
    material: result.material || undefined,
    condition: result.condition,
    category: result.category || 'general',
    colors: Array.isArray(result.colors) ? result.colors : ['various'],
    keywords: Array.isArray(result.keywords) ? result.keywords : [],
    approved: result.approved !== false, // Default to true if not specified
    moderationReason: !result.approved ? 'Content deemed inappropriate by Nova Pro' : undefined,
    short_en: result.short_en,
    long_en: result.long_en,
    stylingTip_en: result.stylingTip_en || undefined,
    short_is: result.short_is,
    long_is: result.long_is,
    stylingTip_is: result.stylingTip_is || undefined
  };
}
