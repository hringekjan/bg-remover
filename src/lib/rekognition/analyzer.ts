import { RekognitionClient, DetectLabelsCommand, DetectTextCommand, DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';

const rekognitionClient = new RekognitionClient({ region: process.env.AWS_REGION || 'eu-west-1' });

export interface RekognitionAnalysisResult {
  approved: boolean;
  reason?: string;

  // From DetectLabels
  labels: string[];
  colors: string[];
  category: string;

  // From DetectText
  brand?: string;
  size?: string;
  material?: string;
  careInstructions?: string[];

  // From DetectModerationLabels
  moderationLabels: Array<{ name: string; confidence: number }>;

  // Raw data for debugging
  rawLabels: any[];
  rawText: any[];
}

/**
 * Run all Rekognition APIs in parallel on original image
 * Total time: ~100ms for all 3 calls combined
 * Total cost: $0.003 per image
 */
export async function analyzeWithRekognition(
  imageBuffer: Buffer,
  bucket?: string,
  key?: string
): Promise<RekognitionAnalysisResult> {

  const imageSource = bucket && key
    ? { S3Object: { Bucket: bucket, Name: key } }
    : { Bytes: imageBuffer };

  // Run all 3 Rekognition APIs in PARALLEL (100ms total vs 300ms sequential)
  const [labelsResponse, textResponse, moderationResponse] = await Promise.all([
    rekognitionClient.send(new DetectLabelsCommand({
      Image: imageSource,
      MaxLabels: 15,
      MinConfidence: 75
    })),
    rekognitionClient.send(new DetectTextCommand({
      Image: imageSource,
      Filters: {
        RegionsOfInterest: [] // Analyze entire image
      }
    })),
    rekognitionClient.send(new DetectModerationLabelsCommand({
      Image: imageSource,
      MinConfidence: 60
    }))
  ]);

  // Process labels
  const labels = (labelsResponse.Labels || []).map(l => l.Name!);
  const colors = extractColors(labelsResponse.Labels || []);
  const category = mapLabelsToCategory(labelsResponse.Labels || []);

  // Process text detections
  const textDetections = textResponse.TextDetections || [];
  const brand = extractBrand(textDetections);
  const size = extractSize(textDetections);
  const material = extractMaterial(textDetections);
  const careInstructions = extractCareInstructions(textDetections);

  // Process moderation
  const moderationLabels = (moderationResponse.ModerationLabels || []).map(l => ({
    name: l.Name!,
    confidence: l.Confidence!
  }));

  // Check if approved (reject if high-confidence inappropriate content)
  const isInappropriate = moderationLabels.some(l =>
    l.confidence > 80 &&
    (l.name.includes('Explicit') || l.name.includes('Violence') || l.name.includes('Suggestive'))
  );

  return {
    approved: !isInappropriate,
    reason: isInappropriate ? `Content moderation failed: ${moderationLabels[0].name}` : undefined,

    labels,
    colors,
    category,

    brand,
    size,
    material,
    careInstructions,

    moderationLabels,

    rawLabels: labelsResponse.Labels || [],
    rawText: textDetections
  };
}

/**
 * Extract colors from Rekognition labels
 */
function extractColors(labels: any[]): string[] {
  const colorKeywords = ['Black', 'White', 'Red', 'Blue', 'Green', 'Yellow', 'Brown', 'Gray', 'Grey', 'Navy', 'Beige', 'Tan', 'Pink', 'Purple', 'Orange', 'Gold', 'Silver'];

  const detectedColors = labels
    .filter(l => colorKeywords.some(color => l.Name?.includes(color)))
    .map(l => l.Name!)
    .slice(0, 3);

  return detectedColors.length > 0 ? detectedColors : ['Various'];
}

/**
 * Map Rekognition labels to product category
 */
function mapLabelsToCategory(labels: any[]): string {
  const labelNames = labels.map(l => l.Name?.toLowerCase() || '');

  // Clothing
  if (labelNames.some(l => l.includes('dress') || l.includes('gown'))) return 'apparel/dress';
  if (labelNames.some(l => l.includes('jacket') || l.includes('coat') || l.includes('blazer'))) return 'apparel/outerwear';
  if (labelNames.some(l => l.includes('shirt') || l.includes('blouse') || l.includes('top'))) return 'apparel/top';
  if (labelNames.some(l => l.includes('pants') || l.includes('jeans') || l.includes('trousers'))) return 'apparel/bottoms';

  // Accessories
  if (labelNames.some(l => l.includes('bag') || l.includes('purse') || l.includes('handbag'))) return 'accessories/bag';
  if (labelNames.some(l => l.includes('shoe') || l.includes('sneaker') || l.includes('boot'))) return 'accessories/footwear';
  if (labelNames.some(l => l.includes('jewelry') || l.includes('necklace') || l.includes('ring'))) return 'accessories/jewelry';

  // Clothing (generic)
  if (labelNames.some(l => l.includes('clothing') || l.includes('apparel'))) return 'apparel/general';

  return 'general';
}

/**
 * Extract brand name from text detections
 * Look for common brand patterns in uppercase text
 */
function extractBrand(textDetections: any[]): string | undefined {
  const commonBrands = ['ZARA', 'H&M', 'NIKE', 'ADIDAS', 'GUCCI', 'PRADA', 'LOUIS VUITTON', 'CHANEL', 'BURBERRY', 'RALPH LAUREN', 'CALVIN KLEIN', 'TOMMY HILFIGER', 'LEVI', 'GAP', 'UNIQLO', 'MANGO', 'COS'];

  for (const detection of textDetections) {
    const text = detection.DetectedText?.toUpperCase() || '';

    // Check if text matches known brands
    for (const brand of commonBrands) {
      if (text.includes(brand)) {
        return brand;
      }
    }

    // Look for brand-like patterns (2-15 uppercase letters)
    if (detection.Type === 'LINE' && /^[A-Z\s&]{2,15}$/.test(text)) {
      return text.trim();
    }
  }

  return undefined;
}

/**
 * Extract size from text detections
 * Look for size patterns like "M", "Size M", "EU 38", "US 8"
 */
function extractSize(textDetections: any[]): string | undefined {
  const sizePatterns = [
    /\b(XXS|XS|S|M|L|XL|XXL|XXXL)\b/i,
    /\bSize\s*:?\s*([A-Z]{1,4})\b/i,
    /\b(EU|US|UK)\s*(\d{1,2})\b/i,
    /\b(\d{1,2})\s*(EU|US|UK)\b/i,
    /\b\d{1,2}\/\d{1,2}\b/ // e.g., "38/40"
  ];

  for (const detection of textDetections) {
    const text = detection.DetectedText || '';

    for (const pattern of sizePatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0].trim();
      }
    }
  }

  return undefined;
}

/**
 * Extract material composition from care labels
 */
function extractMaterial(textDetections: any[]): string | undefined {
  const materialPatterns = [
    /\b\d+%\s*(Cotton|Polyester|Wool|Silk|Leather|Linen|Cashmere|Denim|Nylon|Spandex|Elastane)\b/i,
    /\b(100%|Pure)\s*(Cotton|Wool|Silk|Leather|Linen|Cashmere)\b/i
  ];

  for (const detection of textDetections) {
    const text = detection.DetectedText || '';

    for (const pattern of materialPatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0].trim();
      }
    }
  }

  return undefined;
}

/**
 * Extract care instructions (washing symbols text)
 */
function extractCareInstructions(textDetections: any[]): string[] {
  const careKeywords = ['Machine Wash', 'Hand Wash', 'Dry Clean', 'Do Not Bleach', 'Iron', 'Tumble Dry', 'Line Dry'];

  const instructions: string[] = [];

  for (const detection of textDetections) {
    const text = detection.DetectedText || '';

    for (const keyword of careKeywords) {
      if (text.includes(keyword)) {
        instructions.push(keyword);
      }
    }
  }

  return [...new Set(instructions)]; // Remove duplicates
}
