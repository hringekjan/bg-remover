/**
 * Product Identity Service
 * Multi-signal AI detection for grouping images of the same product
 *
 * Uses 5 weighted signals:
 * - Spatial Layout (40%): SSIM + edge detection + aspect ratio
 * - Feature Matching (35%): ORB keypoint matching
 * - Semantic Analysis (15%): AWS Rekognition labels
 * - Composition (5%): Subject position/size
 * - Background (5%): Color histogram
 */

import { RekognitionClient, DetectLabelsCommand, DetectLabelsCommandInput } from '@aws-sdk/client-rekognition';
import { ImageFeatureExtractor, ImageFeatures } from '../utils/ImageFeatureExtractor';
import type {
  ProductIdentitySettings,
  ProductGroup,
  GroupingResult,
  SimilarityScore
} from '../types/product-identity-settings';

// Rename to avoid conflict with browser's native ImageData type
interface ProductImage {
  id: string;
  url: string;
  features?: ImageFeatures;
}

export class ProductIdentityService {
  private extractor: ImageFeatureExtractor;
  private settings: ProductIdentitySettings;
  private rekognition: RekognitionClient;

  constructor(settings: ProductIdentitySettings) {
    this.extractor = new ImageFeatureExtractor();
    this.settings = settings;
    this.rekognition = new RekognitionClient({
      region: process.env.AWS_REGION || 'eu-west-1',
    });
  }

  /**
   * Group images by product identity
   */
  async groupImages(images: ProductImage[]): Promise<GroupingResult> {
    const startTime = Date.now();
    let cacheHits = 0;

    try {
      // Initialize cache
      await this.extractor.initCache();

      // Extract features for all images (with caching)
      const imagesWithFeatures = await Promise.all(
        images.map(async (img) => {
          const features = await this.extractor.extractFeatures(img.url, img.id);
          if (features.timestamp < Date.now() - 1000) {
            cacheHits++;
          }
          return { ...img, features };
        })
      );

      // Build similarity graph
      const similarityMap = await this.buildSimilarityGraph(imagesWithFeatures);

      // Find connected components (product groups)
      const groups = this.findConnectedComponents(imagesWithFeatures, similarityMap);

      // Split oversized groups
      const finalGroups = this.splitOversizedGroups(groups, similarityMap);

      // Identify ungrouped images
      const groupedImageIds = new Set(
        finalGroups.flatMap(g => g.imageIds)
      );
      const ungroupedImages = images
        .filter(img => !groupedImageIds.has(img.id))
        .map(img => img.id);

      const processingTime = Date.now() - startTime;
      const cacheHitRate = cacheHits / images.length;

      return {
        groups: finalGroups,
        ungroupedImages,
        processingTime,
        cacheHitRate,
      };
    } catch (error) {
      console.error('Product identity grouping failed:', error);
      throw error;
    }
  }

  /**
   * Build similarity graph using multi-signal detection
   */
  private async buildSimilarityGraph(
    images: (ProductImage & { features: ImageFeatures })[]
  ): Promise<Map<string, Map<string, number>>> {
    const similarityMap = new Map<string, Map<string, number>>();

    for (let i = 0; i < images.length; i++) {
      for (let j = i + 1; j < images.length; j++) {
        const score = await this.calculateSimilarity(
          images[i],
          images[j]
        );

        if (score >= this.settings.threshold) {
          // Add bidirectional edges
          if (!similarityMap.has(images[i].id)) {
            similarityMap.set(images[i].id, new Map());
          }
          if (!similarityMap.has(images[j].id)) {
            similarityMap.set(images[j].id, new Map());
          }

          similarityMap.get(images[i].id)!.set(images[j].id, score);
          similarityMap.get(images[j].id)!.set(images[i].id, score);
        }
      }
    }

    return similarityMap;
  }

  /**
   * Calculate overall similarity using weighted signals
   */
  private async calculateSimilarity(
    imgA: ProductImage & { features: ImageFeatures },
    imgB: ProductImage & { features: ImageFeatures }
  ): Promise<number> {
    const weights = this.settings.signalWeights;

    const spatialScore = this.calculateSpatialSimilarity(
      imgA.features,
      imgB.features
    );

    const featureScore = this.calculateFeatureSimilarity(
      imgA.features,
      imgB.features
    );

    const semanticScore = this.settings.useRekognition
      ? await this.calculateSemanticSimilarity(imgA.url, imgB.url)
      : 0.5; // Neutral score when disabled

    const compositionScore = this.calculateCompositionSimilarity(
      imgA.features,
      imgB.features
    );

    const backgroundScore = this.calculateBackgroundSimilarity(
      imgA.features,
      imgB.features
    );

    return (
      weights.spatial * spatialScore +
      weights.feature * featureScore +
      weights.semantic * semanticScore +
      weights.composition * compositionScore +
      weights.background * backgroundScore
    );
  }

  /**
   * Spatial layout similarity: SSIM + edge detection + aspect ratio
   */
  private calculateSpatialSimilarity(
    featuresA: ImageFeatures,
    featuresB: ImageFeatures
  ): number {
    // SSIM calculation (simplified)
    const ssimScore = this.calculateSSIM(
      featuresA.imageData,
      featuresB.imageData
    );

    // Edge similarity
    const edgeScore = this.compareEdges(featuresA.edges, featuresB.edges);

    // Aspect ratio similarity
    const aspectDiff = Math.abs(featuresA.aspectRatio - featuresB.aspectRatio);
    const aspectScore = Math.max(0, 1 - aspectDiff);

    return 0.5 * ssimScore + 0.3 * edgeScore + 0.2 * aspectScore;
  }

  /**
   * SSIM (Structural Similarity Index)
   */
  private calculateSSIM(dataA: ImageData, dataB: ImageData): number {
    const c1 = 6.5025; // (0.01 * 255)^2
    const c2 = 58.5225; // (0.03 * 255)^2

    let meanA = 0, meanB = 0, varA = 0, varB = 0, covar = 0;
    const n = dataA.data.length / 4;

    // Calculate means
    for (let i = 0; i < dataA.data.length; i += 4) {
      const grayA = 0.299 * dataA.data[i] + 0.587 * dataA.data[i + 1] + 0.114 * dataA.data[i + 2];
      const grayB = 0.299 * dataB.data[i] + 0.587 * dataB.data[i + 1] + 0.114 * dataB.data[i + 2];
      meanA += grayA;
      meanB += grayB;
    }
    meanA /= n;
    meanB /= n;

    // Calculate variances and covariance
    for (let i = 0; i < dataA.data.length; i += 4) {
      const grayA = 0.299 * dataA.data[i] + 0.587 * dataA.data[i + 1] + 0.114 * dataA.data[i + 2];
      const grayB = 0.299 * dataB.data[i] + 0.587 * dataB.data[i + 1] + 0.114 * dataB.data[i + 2];
      varA += (grayA - meanA) ** 2;
      varB += (grayB - meanB) ** 2;
      covar += (grayA - meanA) * (grayB - meanB);
    }
    varA /= n;
    varB /= n;
    covar /= n;

    const numerator = (2 * meanA * meanB + c1) * (2 * covar + c2);
    const denominator = (meanA ** 2 + meanB ** 2 + c1) * (varA + varB + c2);

    return numerator / denominator;
  }

  /**
   * Compare edge maps
   */
  private compareEdges(edgesA: number[][], edgesB: number[][]): number {
    if (edgesA.length !== edgesB.length) return 0;

    let totalDiff = 0;
    let count = 0;

    for (let y = 0; y < edgesA.length; y++) {
      if (edgesA[y].length !== edgesB[y].length) continue;
      for (let x = 0; x < edgesA[y].length; x++) {
        totalDiff += Math.abs(edgesA[y][x] - edgesB[y][x]);
        count++;
      }
    }

    const avgDiff = count > 0 ? totalDiff / count : 255;
    return Math.max(0, 1 - avgDiff / 255);
  }

  /**
   * Feature matching using ORB keypoints (simplified - would use actual ORB in production)
   */
  private calculateFeatureSimilarity(
    featuresA: ImageFeatures,
    featuresB: ImageFeatures
  ): number {
    // Simplified feature matching using histogram correlation
    const corrR = this.correlate(
      featuresA.histogram.slice(0, 32),
      featuresB.histogram.slice(0, 32)
    );
    const corrG = this.correlate(
      featuresA.histogram.slice(32, 64),
      featuresB.histogram.slice(32, 64)
    );
    const corrB = this.correlate(
      featuresA.histogram.slice(64, 96),
      featuresB.histogram.slice(64, 96)
    );

    return (corrR + corrG + corrB) / 3;
  }

  /**
   * Pearson correlation coefficient
   */
  private correlate(a: number[], b: number[]): number {
    const n = a.length;
    const meanA = a.reduce((sum, v) => sum + v, 0) / n;
    const meanB = b.reduce((sum, v) => sum + v, 0) / n;

    let numerator = 0;
    let denomA = 0;
    let denomB = 0;

    for (let i = 0; i < n; i++) {
      const diffA = a[i] - meanA;
      const diffB = b[i] - meanB;
      numerator += diffA * diffB;
      denomA += diffA * diffA;
      denomB += diffB * diffB;
    }

    const denominator = Math.sqrt(denomA * denomB);
    return denominator > 0 ? numerator / denominator : 0;
  }

  /**
   * Semantic similarity using AWS Rekognition DetectLabels API
   *
   * @param urlA - URL of first image
   * @param urlB - URL of second image
   * @returns Similarity score (0-1) based on label and brand overlap
   */
  private async calculateSemanticSimilarity(
    urlA: string,
    urlB: string
  ): Promise<number> {
    if (!this.settings.useRekognition) {
      return 0.5; // Neutral score when disabled
    }

    try {
      const config = this.settings.rekognitionConfig || { minConfidence: 50, maxLabels: 20 };

      // Fetch image bytes from URLs
      const [imageA, imageB] = await Promise.all([
        this.fetchImageBytes(urlA),
        this.fetchImageBytes(urlB),
      ]);

      // Call Rekognition DetectLabels and brand detection for both images
      const [labelsA, labelsB, brandsA, brandsB] = await Promise.all([
        this.detectLabels(imageA, config),
        this.detectLabels(imageB, config),
        this.detectBrands(imageA, config),
        this.detectBrands(imageB, config),
      ]);

      // Calculate label similarity
      const labelSimilarity = this.calculateLabelSimilarity(labelsA, labelsB);

      // Calculate brand similarity (higher weight for brand match)
      const brandSimilarity = this.calculateBrandSimilarity(brandsA, brandsB);

      // Combine similarities: 70% label + 30% brand
      const combinedSimilarity = 0.7 * labelSimilarity + 0.3 * brandSimilarity;

      console.log('[ProductIdentity] Rekognition similarity calculated', {
        urlA: urlA.substring(0, 50) + '...',
        urlB: urlB.substring(0, 50) + '...',
        labelsACount: labelsA.length,
        labelsBCount: labelsB.length,
        brandsACount: brandsA.length,
        brandsBCount: brandsB.length,
        brandMatch: brandSimilarity === 1.0,
        similarity: combinedSimilarity.toFixed(3),
      });

      return combinedSimilarity;
    } catch (error) {
      console.error('[ProductIdentity] Rekognition error:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0.5; // Fallback to neutral score on error
    }
  }

  /**
   * Fetch image bytes from URL with timeout
   */
  private async fetchImageBytes(url: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeoutMs = 5000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Detect labels in image using AWS Rekognition
   */
  private async detectLabels(
    imageBytes: Uint8Array,
    config: { minConfidence: number; maxLabels: number }
  ): Promise<Array<{ name: string; confidence: number }>> {
    const input: DetectLabelsCommandInput = {
      Image: {
        Bytes: imageBytes,
      },
      MaxLabels: config.maxLabels,
      MinConfidence: config.minConfidence,
      Features: ['GENERAL_LABELS'],
      Settings: {
        GeneralLabels: {
          LabelInclusionFilters: [],
          LabelExclusionFilters: [],
          LabelCategoryInclusionFilters: [],
          LabelCategoryExclusionFilters: [],
        },
      },
    };

    const command = new DetectLabelsCommand(input);
    const response = await this.rekognition.send(command);

    return (response.Labels || []).map(label => ({
      name: label.Name || '',
      confidence: label.Confidence || 0,
    }));
  }

  /**
   * Detect brands in image using AWS Rekognition
   * Extracts brand names from label hierarchy (parent labels)
   */
  private async detectBrands(
    imageBytes: Uint8Array,
    config: { minConfidence: number; maxLabels: number }
  ): Promise<Array<{ name: string; confidence: number }>> {
    const input: DetectLabelsCommandInput = {
      Image: {
        Bytes: imageBytes,
      },
      MaxLabels: config.maxLabels,
      MinConfidence: config.minConfidence,
      Features: ['GENERAL_LABELS'],
    };

    const command = new DetectLabelsCommand(input);
    const response = await this.rekognition.send(command);

    // Extract brands from label hierarchy
    const brands: Array<{ name: string; confidence: number }> = [];
    const seenBrands = new Set<string>();

    for (const label of response.Labels || []) {
      const name = label.Name || '';
      const lowerName = name.toLowerCase();

      if (seenBrands.has(lowerName)) continue;

      // Check if label has 'Brand' category
      const isBrand = (label.Categories || []).some(
        cat => cat.Name?.toLowerCase().includes('brand')
      );

      // Detect potential brands by name patterns and high confidence
      const potentialBrand =
        name.length > 2 &&
        !lowerName.includes('product') &&
        !lowerName.includes('electronics') &&
        !lowerName.includes('clothing') &&
        !lowerName.includes('food') &&
        !lowerName.includes('animal') &&
        !lowerName.includes('plant') &&
        label.Confidence && label.Confidence > 70;

      if (isBrand || potentialBrand) {
        seenBrands.add(lowerName);
        brands.push({
          name: name,
          confidence: label.Confidence || 0,
        });
      }

      // Check parent labels for brand names
      for (const parent of label.Parents || []) {
        const parentName = parent.Name || '';
        const lowerParent = parentName.toLowerCase();

        if (seenBrands.has(lowerParent)) continue;

        if (label.Confidence && label.Confidence > 80) {
          seenBrands.add(lowerParent);
          brands.push({
            name: parentName,
            confidence: label.Confidence,
          });
        }
      }
    }

    return brands;
  }

  /**
   * Calculate brand similarity between two image brand sets
   * Returns 1.0 if both images have the same brand, 0.5 otherwise
   */
  private calculateBrandSimilarity(
    brandsA: Array<{ name: string; confidence: number }>,
    brandsB: Array<{ name: string; confidence: number }>
  ): number {
    if (brandsA.length === 0 || brandsB.length === 0) {
      return 0.5;
    }

    const brandNamesA = new Set(brandsA.map((b: { name: string }) => b.name.toLowerCase()));
    const brandNamesB = new Set(brandsB.map((b: { name: string }) => b.name.toLowerCase()));

    const hasMatch = [...brandNamesA].some(brand => brandNamesB.has(brand));
    return hasMatch ? 1.0 : 0.5;
  }

  /**
   * Calculate similarity between two label sets using weighted Jaccard index
   */
  private calculateLabelSimilarity(
    labelsA: Array<{ name: string; confidence: number }>,
    labelsB: Array<{ name: string; confidence: number }>
  ): number {
    if (labelsA.length === 0 || labelsB.length === 0) {
      return 0.5; // Neutral score if no labels detected
    }

    // Create maps for efficient lookup
    const mapA = new Map(labelsA.map(l => [l.name.toLowerCase(), l.confidence]));
    const mapB = new Map(labelsB.map(l => [l.name.toLowerCase(), l.confidence]));

    // Find intersection and union
    const intersection = new Set<string>();
    const union = new Set<string>();

    for (const name of mapA.keys()) {
      union.add(name);
      if (mapB.has(name)) {
        intersection.add(name);
      }
    }

    for (const name of mapB.keys()) {
      union.add(name);
    }

    if (union.size === 0) {
      return 0.5;
    }

    // Calculate weighted Jaccard similarity
    let intersectionWeight = 0;
    let unionWeight = 0;

    for (const name of union) {
      const weightA = mapA.get(name)?.valueOf() || 0;
      const weightB = mapB.get(name)?.valueOf() || 0;
      const maxWeight = Math.max(weightA, weightB);

      unionWeight += maxWeight;

      if (intersection.has(name)) {
        const minWeight = Math.min(weightA, weightB);
        intersectionWeight += minWeight;
      }
    }

    return unionWeight > 0 ? intersectionWeight / unionWeight : 0.5;
  }

  /**
   * Composition similarity (subject position and size)
   */
  private calculateCompositionSimilarity(
    featuresA: ImageFeatures,
    featuresB: ImageFeatures
  ): number {
    // Simplified: compare aspect ratios as proxy for composition
    const aspectDiff = Math.abs(featuresA.aspectRatio - featuresB.aspectRatio);
    return Math.max(0, 1 - aspectDiff);
  }

  /**
   * Background similarity using color histograms
   */
  private calculateBackgroundSimilarity(
    featuresA: ImageFeatures,
    featuresB: ImageFeatures
  ): number {
    return this.correlate(featuresA.histogram, featuresB.histogram);
  }

  /**
   * Find connected components using DFS
   */
  private findConnectedComponents(
    images: ProductImage[],
    similarityMap: Map<string, Map<string, number>>
  ): ProductGroup[] {
    const visited = new Set<string>();
    const groups: ProductGroup[] = [];

    for (const image of images) {
      if (visited.has(image.id)) continue;

      const group = this.dfs(image.id, similarityMap, visited);
      if (group.length >= this.settings.minGroupSize) {
        groups.push(this.createGroup(group, similarityMap));
      }
    }

    return groups;
  }

  /**
   * Depth-first search for connected component
   */
  private dfs(
    nodeId: string,
    graph: Map<string, Map<string, number>>,
    visited: Set<string>
  ): string[] {
    const stack = [nodeId];
    const component: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;

      visited.add(current);
      component.push(current);

      const neighbors = graph.get(current);
      if (neighbors) {
        for (const neighbor of neighbors.keys()) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
    }

    return component;
  }

  /**
   * Create product group with metadata
   */
  private createGroup(
    imageIds: string[],
    similarityMap: Map<string, Map<string, number>>
  ): ProductGroup {
    const similarities: number[] = [];

    for (let i = 0; i < imageIds.length; i++) {
      for (let j = i + 1; j < imageIds.length; j++) {
        const score = similarityMap.get(imageIds[i])?.get(imageIds[j]) ?? 0;
        if (score > 0) {
          similarities.push(score);
        }
      }
    }

    const avgSimilarity = similarities.length > 0
      ? similarities.reduce((sum, s) => sum + s, 0) / similarities.length
      : 0;

    return {
      id: crypto.randomUUID(),
      imageIds,
      averageSimilarity: avgSimilarity,
      confidence: avgSimilarity,
      groupType: 'automatic',
      metadata: {
        memberCount: imageIds.length,
        minSimilarity: Math.min(...similarities, 0),
        maxSimilarity: Math.max(...similarities, 0),
      },
    };
  }

  /**
   * Split groups larger than maxGroupSize
   */
  private splitOversizedGroups(
    groups: ProductGroup[],
    similarityMap: Map<string, Map<string, number>>
  ): ProductGroup[] {
    const result: ProductGroup[] = [];

    for (const group of groups) {
      if (group.imageIds.length <= this.settings.maxGroupSize) {
        result.push(group);
        continue;
      }

      // Split by removing weakest edges iteratively
      const subgroups = this.hierarchicalSplit(group, similarityMap);
      result.push(...subgroups);
    }

    return result;
  }

  /**
   * Hierarchical splitting by removing weakest edges
   */
  private hierarchicalSplit(
    group: ProductGroup,
    similarityMap: Map<string, Map<string, number>>
  ): ProductGroup[] {
    // Get all edges in the group
    const edges: Array<{ a: string; b: string; weight: number }> = [];

    for (let i = 0; i < group.imageIds.length; i++) {
      for (let j = i + 1; j < group.imageIds.length; j++) {
        const weight = similarityMap.get(group.imageIds[i])?.get(group.imageIds[j]) ?? 0;
        if (weight > 0) {
          edges.push({
            a: group.imageIds[i],
            b: group.imageIds[j],
            weight,
          });
        }
      }
    }

    // Sort edges by weight (ascending)
    edges.sort((a, b) => a.weight - b.weight);

    // Remove weakest edge and re-check components
    const graphCopy = new Map(similarityMap);

    for (const edge of edges) {
      graphCopy.get(edge.a)?.delete(edge.b);
      graphCopy.get(edge.b)?.delete(edge.a);

      // Re-find connected components
      const visited = new Set<string>();
      const components: string[][] = [];

      for (const imageId of group.imageIds) {
        if (visited.has(imageId)) continue;
        const component = this.dfs(imageId, graphCopy, visited);
        if (component.length > 0) {
          components.push(component);
        }
      }

      // Check if all components are within size limit
      const allWithinLimit = components.every(
        c => c.length <= this.settings.maxGroupSize
      );

      if (allWithinLimit) {
        return components.map(c => this.createGroup(c, similarityMap));
      }
    }

    // Fallback: just split into smaller chunks
    const chunks: string[][] = [];
    for (let i = 0; i < group.imageIds.length; i += this.settings.maxGroupSize) {
      chunks.push(group.imageIds.slice(i, i + this.settings.maxGroupSize));
    }

    return chunks.map(c => this.createGroup(c, similarityMap));
  }
}
