import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'eu-west-1' });

import { type ProductDescription, type ProductCondition, type BilingualProductDescription } from '../types';
import { routeToModel, type ImageMetadata, type ProcessingOptions } from '../routing/model-router';

export type { ProductDescription, BilingualProductDescription };

export async function analyzeImageForDescription(
  imageBuffer: Buffer,
  productName?: string,
  metadata?: ImageMetadata
): Promise<ProductDescription> {
  const base64Image = imageBuffer.toString('base64');
  const validConditions: ProductCondition[] = ['new_with_tags', 'like_new', 'very_good', 'good', 'fair'];

  // Dynamic model selection using routing logic
  let selectedModelId: string;
  let routingTier: string = 'default';
  let routingConfidence: number = 0.85;

  if (metadata) {
    // Use intelligent routing based on image complexity
    const processingOptions: ProcessingOptions = {
      generateDescription: true,
    };
    const routingDecision = routeToModel(metadata, processingOptions);
    selectedModelId = routingDecision.modelId;
    routingTier = routingDecision.tier;
    routingConfidence = routingDecision.confidence;

    console.info('Model routing decision', {
      tier: routingDecision.tier,
      modelId: selectedModelId,
      reason: routingDecision.reason,
      confidence: routingDecision.confidence,
      complexityScore: routingDecision.metadata.complexityScore,
      megapixels: routingDecision.metadata.megapixels,
      fileSizeMB: routingDecision.metadata.fileSizeMB,
    });
  } else {
    // Fallback to default tier if no metadata provided
    selectedModelId = 'amazon.nova-lite-v1:0';
    console.warn('No metadata provided for routing, using default tier');
  }

  const modelsToTry = [
    selectedModelId,  // Primary model from routing decision
  ];

  const prompt = `Act as a high-end fashion copywriter for Hringekjan.is. 
Generate elegant, professional product metadata for a premium second-hand item.

Context:
${productName ? `- Product Name: ${productName}` : ''}

Instructions:
1. Provide a specific 'Elegant Name' (e.g., 'Tailored Silk Blouse' instead of just 'Shirt').
2. Write a 3-sentence 'Marketing Description' that sounds timeless, sophisticated, and sustainable.
3. Identify the product category (clothing, accessories, etc.).
4. List main colors.
5. Provide a product condition assessment (choose from: new_with_tags, like_new, very_good, good, fair).
6. Suggest relevant SEO keywords.
7. Include a 'Styling Tip'.

Format your response as JSON with keys: short, long, category, colors, condition, keywords, stylingTip`;

  // Try each model in order
  for (const modelId of modelsToTry) {
    try {
      // Prioritize Nova Pro for elegant fashion runs if available or requested
      const actualModelId = (selectedModelId.includes('nova-lite') && routingTier === 'premium') 
        ? 'amazon.nova-pro-v1:0' 
        : modelId;

      console.log(`Trying model: ${actualModelId}`, {
        tier: routingTier,
        confidence: routingConfidence,
        hasMetadata: !!metadata,
      });

      // Nova models use Messages API with native image support
      const requestBody = {
        max_tokens: 1000,
        temperature: 0.7,
        system: [{ text: "You are an expert fashion curator and copywriter for Hringekjan, a premium sustainable marketplace." }],
        messages: [
          {
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
                text: prompt
              }
            ]
          }
        ]
      };

      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId: actualModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody)
      }));

      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      // Nova Converse API response structure
      const analysisText: string = responseBody.output?.message?.content?.[0]?.text || '';

      if (!analysisText) {
        throw new Error(`No text content in response from ${actualModelId}`);
      }

      // Extract JSON from potential conversational wrapper
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      const parsedJSON = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(analysisText);

      const condition = parsedJSON.condition && validConditions.includes(parsedJSON.condition as ProductCondition)
        ? parsedJSON.condition as ProductCondition
        : 'very_good';

      console.log(`Successfully analyzed with model: ${actualModelId}`);

      return {
        short: parsedJSON.short || parsedJSON.en_name || productName || 'Product',
        long: parsedJSON.long || parsedJSON.en_description || 'High-quality product processed and optimized for sale.',
        category: parsedJSON.category || 'General',
        colors: Array.isArray(parsedJSON.colors) ? parsedJSON.colors : (parsedJSON.colors ? parsedJSON.colors.split(',').map((c: string) => c.trim()) : ['various']),
        condition,
        keywords: Array.isArray(parsedJSON.keywords) ? parsedJSON.keywords : (parsedJSON.keywords ? parsedJSON.keywords.split(',').map((k: string) => k.trim()) : ['product']),
        stylingTip: parsedJSON.stylingTip
      };
    } catch (error) {
      console.error(`Model ${modelId} failed:`, error instanceof Error ? error.message : String(error));
      // Continue to next model
    }
  }

  // Provide intelligent analysis based on product name and context
  console.log('Using intelligent analysis for:', productName);

  // Enhanced category detection with more comprehensive patterns
  let category = 'general';
  let keywords: string[] = ['product', 'item'];
  let defaultColors: string[] = ['black', 'white', 'gray'];
  let condition: ProductCondition = 'very_good';
  let shortDescription = productName || 'Product';
  let longDescription = 'High-quality item processed and optimized for sale.';

  if (productName) {
    const name = productName.toLowerCase();

    // Clothing detection
    if (name.includes('dress') || name.includes('gown') || name.includes('skirt')) {
      category = 'clothing';
      keywords = ['fashion', 'apparel', 'clothing', 'dress'];
      defaultColors = ['red', 'blue', 'black', 'white', 'navy', 'gray'];
      shortDescription = productName;
      longDescription = 'Elegant and stylish clothing item, perfect for any occasion. High-quality fabric with excellent craftsmanship.';
      condition = 'very_good';
    } else if (name.includes('shirt') || name.includes('blouse') || name.includes('top')) {
      category = 'clothing';
      keywords = ['fashion', 'apparel', 'clothing', 'shirt', 'top'];
      defaultColors = ['white', 'black', 'blue', 'gray', 'striped'];
      shortDescription = productName;
      longDescription = 'Comfortable and versatile clothing top, ideal for casual or professional wear.';
      condition = 'very_good';
    } else if (name.includes('pants') || name.includes('jeans') || name.includes('trousers')) {
      category = 'clothing';
      keywords = ['fashion', 'apparel', 'clothing', 'pants', 'bottoms'];
      defaultColors = ['blue', 'black', 'gray', 'khaki', 'white'];
      shortDescription = productName;
      longDescription = 'Durable and comfortable bottom wear, perfect for everyday use.';
      condition = 'very_good';
    } else if (name.includes('jacket') || name.includes('coat') || name.includes('blazer')) {
      category = 'clothing';
      keywords = ['fashion', 'apparel', 'clothing', 'outerwear', 'jacket'];
      defaultColors = ['black', 'navy', 'gray', 'brown', 'beige'];
      shortDescription = productName;
      longDescription = 'Stylish outerwear piece, providing both fashion and function.';
      condition = 'very_good';
    }

    // Accessories detection
    else if (name.includes('bag') || name.includes('purse') || name.includes('handbag')) {
      category = 'accessories';
      keywords = ['accessory', 'fashion', 'bag', 'handbag', 'style'];
      defaultColors = ['black', 'brown', 'tan', 'red', 'navy'];
      shortDescription = productName;
      longDescription = 'Elegant and functional accessory, perfect for carrying essentials in style.';
      condition = 'very_good';
    } else if (name.includes('shoes') || name.includes('sneakers') || name.includes('boots')) {
      category = 'accessories';
      keywords = ['fashion', 'footwear', 'shoes', 'style'];
      defaultColors = ['black', 'white', 'brown', 'navy', 'red'];
      shortDescription = productName;
      longDescription = 'Comfortable and stylish footwear, designed for both fashion and function.';
      condition = 'very_good';
    } else if (name.includes('jewelry') || name.includes('necklace') || name.includes('ring') || name.includes('earrings')) {
      category = 'accessories';
      keywords = ['jewelry', 'accessory', 'fashion', 'style'];
      defaultColors = ['gold', 'silver', 'rose gold', 'white', 'black'];
      shortDescription = productName;
      longDescription = 'Beautiful jewelry piece, adding elegance and sophistication to any outfit.';
      condition = 'very_good';
    }

    // Electronics detection - check most specific first
    else if (name.includes('headphones') || name.includes('earbuds') || name.includes('audio')) {
      category = 'electronics';
      keywords = ['audio', 'electronics', 'music', 'headphones'];
      defaultColors = ['black', 'white', 'blue', 'red'];
      shortDescription = productName;
      longDescription = 'High-quality audio device delivering exceptional sound experience.';
      condition = 'very_good';
    } else if (name.includes('computer') || name.includes('laptop') || name.includes('macbook')) {
      category = 'electronics';
      keywords = ['technology', 'computer', 'laptop', 'electronics'];
      defaultColors = ['silver', 'gray', 'black', 'white'];
      shortDescription = productName;
      longDescription = 'Powerful computing device, perfect for work, study, or entertainment.';
      condition = 'good';
    } else if (name.includes('phone') || name.includes('iphone') || name.includes('samsung') || name.includes('mobile')) {
      category = 'electronics';
      keywords = ['technology', 'electronics', 'mobile', 'smartphone'];
      defaultColors = ['black', 'white', 'blue', 'gray', 'gold'];
      shortDescription = productName;
      longDescription = 'Advanced mobile device with cutting-edge technology and features.';
      condition = 'good'; // Phones often show more wear
    }

    // Home goods detection
    else if (name.includes('furniture') || name.includes('chair') || name.includes('table') || name.includes('sofa')) {
      category = 'home_goods';
      keywords = ['furniture', 'home', 'decor', 'interior'];
      defaultColors = ['brown', 'black', 'white', 'gray', 'beige'];
      shortDescription = productName;
      longDescription = 'Beautiful and functional furniture piece for your home.';
      condition = 'good'; // Furniture can show wear
    } else if (name.includes('kitchen') || name.includes('cookware') || name.includes('appliance')) {
      category = 'home_goods';
      keywords = ['kitchen', 'cooking', 'home', 'appliance'];
      defaultColors = ['silver', 'black', 'white', 'red'];
      shortDescription = productName;
      longDescription = 'Essential kitchen item for cooking and food preparation.';
      condition = 'very_good';
    }

    // Books and media
    else if (name.includes('book') || name.includes('novel') || name.includes('textbook')) {
      category = 'books';
      keywords = ['reading', 'literature', 'book', 'education'];
      defaultColors = ['various'];
      shortDescription = productName;
      longDescription = 'Engaging reading material, perfect for entertainment or learning.';
      condition = 'good'; // Books show wear from reading
    }

    // Sports and outdoors
    else if (name.includes('bike') || name.includes('bicycle') || name.includes('sports') || name.includes('fitness')) {
      category = 'sports_outdoors';
      keywords = ['sports', 'fitness', 'outdoor', 'active'];
      defaultColors = ['black', 'blue', 'red', 'white'];
      shortDescription = productName;
      longDescription = 'High-performance sports and outdoor equipment.';
      condition = 'good'; // Sports gear shows usage
    }

    // Generic fallback with smart analysis
    else {
      category = 'general';
      keywords = ['product', 'item', 'quality'];
      defaultColors = ['black', 'white', 'gray', 'blue'];
      shortDescription = productName;
      longDescription = 'High-quality product in excellent condition, ready for immediate use.';
      condition = 'very_good';
    }
  }

  return {
    short: shortDescription,
    long: longDescription,
    category,
    colors: defaultColors,
    condition,
    keywords
  };
}

export async function translateToIcelandic(description: ProductDescription): Promise<ProductDescription> {
  try {
    // Try GPT OSS model for Icelandic translation
    const translationResponse = await bedrockClient.send(new InvokeModelCommand({
      modelId: 'openai.gpt-oss-120b-1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: `Translate this product description to Icelandic. Keep the same structure and format.

Short: ${description.short}
Long: ${description.long}
Category: ${description.category || 'General'}
Colors: ${description.colors?.join(', ') || ''}
Condition: ${description.condition || ''}
Keywords: ${description.keywords.join(', ')}

Provide the response in the same JSON format with keys: short, long, category, colors, condition, keywords`
          }
        ],
        max_tokens: 1000,
        temperature: 0.3
      })
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(translationResponse.body));
    let translationText = responseBody.choices?.[0]?.message?.content || responseBody.content || '';

    // Handle GPT OSS specific response format
    // GPT OSS might return reasoning + content, extract just the JSON part
    const jsonMatch = translationText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      translationText = jsonMatch[0];
    }

    // Parse the JSON response
    const translation = JSON.parse(translationText);

    return {
      short: translation.short || description.short,
      long: translation.long || description.long,
      category: translation.category || description.category,
      colors: Array.isArray(translation.colors) ? translation.colors : description.colors,
      condition: translation.condition || description.condition,
      keywords: Array.isArray(translation.keywords) ? translation.keywords : description.keywords
    };
  } catch (error) {
    console.error('Translation failed, returning original:', error instanceof Error ? error.message : String(error));
    // Return the original description if translation fails
    return description;
  }
}

export async function generateBilingualDescription(
  imageBuffer: Buffer,
  productName?: string,
  metadata?: ImageMetadata
): Promise<BilingualProductDescription> {
  const englishDescription = await analyzeImageForDescription(imageBuffer, productName, metadata);
  const icelandicDescription = await translateToIcelandic(englishDescription);

  return {
    en: englishDescription,
    is: icelandicDescription
  };
}