import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-east-1' });
const NOVA_MODEL_ID = 'us.mistral.pixtral-large-2502-v1:0';

export interface MistralPixtralAnalysisResult {
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
 * Single Mistral Pixtral Large call to:
 * 1. Extract brand/size/material from image tags (OCR)
 * 2. Assess product condition
 * 3. Generate premium English description
 * 4. Translate to Icelandic natively
 * 5. Check content appropriateness
 *
 * Replaces: Multi-model pipeline (Nova Lite + GPT-OSS-120B)
 * Cost: ~$0.06 per image (vs $0.10 for 2 calls)
 * Time: 2-3s (single multimodal model handles all tasks)
 */
export async function analyzeWithMistralPixtral(
  processedImageBuffer: Buffer,
  productName?: string,
  rekognitionHints?: {
    labels?: string[];
    detectedBrand?: string;
    detectedSize?: string;
    category?: string;
    colors?: string[];
  }
): Promise<MistralPixtralAnalysisResult> {

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

  // Mistral Pixtral format: system message goes in first user message
  const systemPrompt = "You are an expert fashion curator and copywriter for Hringekjan.is, a premium sustainable marketplace in Iceland. You provide elegant, sophisticated, timeless product descriptions that emphasize quality and sustainability.\n\n";

  // Build detailed prompt that LEADS with Rekognition hints as PRIMARY facts
  const taskPrompt = rekognitionHints?.labels
    ? `Analyze this luxury second-hand fashion item for Hringekjan.is marketplace.${productName ? ` Product name: "${productName}"` : ''}

**🔍 DETECTED FEATURES (PRIMARY SOURCE - USE THESE AS FOUNDATION):**
Our computer vision analysis has already identified these features. Base your description primarily on these detected attributes:

${rekognitionHints.labels ? `• Detected visual elements: ${rekognitionHints.labels.join(', ')}` : ''}${
  rekognitionHints.detectedBrand ? `\n• Brand identified: ${rekognitionHints.detectedBrand}` : ''
}${
  rekognitionHints.detectedSize ? `\n• Size detected: ${rekognitionHints.detectedSize}` : ''
}${
  rekognitionHints.category ? `\n• Category classification: ${rekognitionHints.category}` : ''
}${
  rekognitionHints.colors?.length ? `\n• Color palette: ${rekognitionHints.colors.join(', ')}` : ''
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
- Same styling tip in Icelandic`
    : `Analyze this luxury second-hand fashion item for Hringekjan.is marketplace.${productName ? ` Product name: "${productName}"` : ''}

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
- Same styling tip in Icelandic`;

  const requestBody = {
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`
          }
        },
        {
          type: 'text',
          text: systemPrompt + taskPrompt + `

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

  console.log('Invoking Mistral Pixtral Large for comprehensive analysis...', {
    productName,
    hasRekognitionHints: !!rekognitionHints,
    hintsLabels: rekognitionHints?.labels?.length || 0,
    modelId: NOVA_MODEL_ID,
  });

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: NOVA_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody)
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  console.log('Bedrock response structure:', {
    hasOutput: !!responseBody.output,
    hasChoices: !!responseBody.choices,
    hasMessage: !!responseBody.message,
    responseKeys: Object.keys(responseBody),
    firstChoiceKeys: responseBody.choices?.[0] ? Object.keys(responseBody.choices[0]) : []
  });

  // Try different response formats (Mistral vs Nova)
  const analysisText =
    responseBody.output?.message?.content?.[0]?.text ||  // Nova format
    responseBody.choices?.[0]?.message?.content ||        // Mistral format
    responseBody.content?.[0]?.text ||                    // Alternative format
    '';

  if (!analysisText) {
    console.error('Unable to extract text from response:', JSON.stringify(responseBody, null, 2).substring(0, 500));
    throw new Error('No response from Mistral Pixtral Large');
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
    throw new Error('Mistral Pixtral Large response missing required description fields');
  }

  // Ensure condition is valid
  const validConditions = ['new_with_tags', 'like_new', 'very_good', 'good', 'fair'];
  if (!validConditions.includes(result.condition)) {
    console.warn(`Invalid condition "${result.condition}", defaulting to "very_good"`);
    result.condition = 'very_good';
  }

  console.log('Mistral Pixtral Large analysis complete:', {
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
    brand: (result.brand === "null" || !result.brand) ? undefined : result.brand,
    size: (result.size === "null" || !result.size) ? undefined : result.size,
    material: (result.material === "null" || !result.material) ? undefined : result.material,
    condition: result.condition,
    category: result.category || 'general',
    colors: Array.isArray(result.colors) ? result.colors : ['various'],
    keywords: Array.isArray(result.keywords) ? result.keywords : [],
    approved: result.approved !== false, // Default to true if not specified
    moderationReason: !result.approved ? 'Content deemed inappropriate by Mistral Pixtral Large' : undefined,
    short_en: result.short_en,
    long_en: result.long_en,
    stylingTip_en: result.stylingTip_en || undefined,
    short_is: result.short_is,
    long_is: result.long_is,
    stylingTip_is: result.stylingTip_is || undefined
  };
}
