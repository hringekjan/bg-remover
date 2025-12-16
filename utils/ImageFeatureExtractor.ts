/**
 * Image Feature Extractor
 * Handles canvas operations, edge detection, and IndexedDB caching for product identity detection
 */

export interface ImageFeatures {
  imageData: ImageData;
  edges: number[][];
  aspectRatio: number;
  width: number;
  height: number;
  histogram: number[];
  timestamp: number;
}

const CACHE_NAME = 'product-identity-cache';
const CACHE_VERSION = 1;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const RESIZE_SIZE = 256; // Resize all images to 256x256 for comparison

export class ImageFeatureExtractor {
  private db: IDBDatabase | null = null;

  /**
   * Initialize IndexedDB for caching
   */
  async initCache(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_NAME, CACHE_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('features')) {
          db.createObjectStore('features', { keyPath: 'imageId' });
        }
      };
    });
  }

  /**
   * Extract features from an image with caching
   */
  async extractFeatures(imageUrl: string, imageId: string): Promise<ImageFeatures> {
    // Try cache first
    const cached = await this.getFromCache(imageId);
    if (cached) {
      return cached;
    }

    // Load and process image
    const img = await this.loadImage(imageUrl);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Resize to standard size
    canvas.width = RESIZE_SIZE;
    canvas.height = RESIZE_SIZE;
    ctx.drawImage(img, 0, 0, RESIZE_SIZE, RESIZE_SIZE);

    const imageData = ctx.getImageData(0, 0, RESIZE_SIZE, RESIZE_SIZE);
    const edges = this.detectEdges(imageData);
    const histogram = this.calculateHistogram(imageData);

    const features: ImageFeatures = {
      imageData,
      edges,
      aspectRatio: img.width / img.height,
      width: img.width,
      height: img.height,
      histogram,
      timestamp: Date.now(),
    };

    // Cache for future use
    await this.saveToCache(imageId, features);

    return features;
  }

  /**
   * Load image from URL
   */
  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });
  }

  /**
   * Sobel edge detection
   */
  private detectEdges(imageData: ImageData): number[][] {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const edges: number[][] = [];

    // Convert to grayscale first
    const gray: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    // Sobel kernels
    const sobelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
    const sobelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

    for (let y = 1; y < height - 1; y++) {
      const row: number[] = [];
      for (let x = 1; x < width - 1; x++) {
        let gx = 0;
        let gy = 0;

        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = (y + ky) * width + (x + kx);
            gx += gray[idx] * sobelX[ky + 1][kx + 1];
            gy += gray[idx] * sobelY[ky + 1][kx + 1];
          }
        }

        row.push(Math.sqrt(gx * gx + gy * gy));
      }
      edges.push(row);
    }

    return edges;
  }

  /**
   * Calculate color histogram for background consistency
   */
  private calculateHistogram(imageData: ImageData): number[] {
    const bins = 32; // 32 bins for RGB
    const histogram = new Array(bins * 3).fill(0);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = Math.floor((data[i] / 256) * bins);
      const g = Math.floor((data[i + 1] / 256) * bins);
      const b = Math.floor((data[i + 2] / 256) * bins);

      histogram[r]++;
      histogram[bins + g]++;
      histogram[bins * 2 + b]++;
    }

    // Normalize
    const total = imageData.width * imageData.height;
    return histogram.map(count => count / total);
  }

  /**
   * Get features from IndexedDB cache
   */
  private async getFromCache(imageId: string): Promise<ImageFeatures | null> {
    if (!this.db) {
      await this.initCache();
    }

    return new Promise((resolve) => {
      if (!this.db) {
        resolve(null);
        return;
      }

      const transaction = this.db.transaction(['features'], 'readonly');
      const store = transaction.objectStore('features');
      const request = store.get(imageId);

      request.onsuccess = () => {
        const cached = request.result;
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          // Convert stored data back to ImageData
          const imageData = new ImageData(
            new Uint8ClampedArray(cached.imageDataArray),
            RESIZE_SIZE,
            RESIZE_SIZE
          );
          resolve({ ...cached, imageData });
        } else {
          resolve(null);
        }
      };

      request.onerror = () => resolve(null);
    });
  }

  /**
   * Save features to IndexedDB cache
   */
  private async saveToCache(imageId: string, features: ImageFeatures): Promise<void> {
    if (!this.db) {
      await this.initCache();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }

      const transaction = this.db.transaction(['features'], 'readwrite');
      const store = transaction.objectStore('features');

      // Convert ImageData to storable format
      const cacheData = {
        imageId,
        imageDataArray: Array.from(features.imageData.data),
        edges: features.edges,
        aspectRatio: features.aspectRatio,
        width: features.width,
        height: features.height,
        histogram: features.histogram,
        timestamp: features.timestamp,
      };

      const request = store.put(cacheData);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear expired cache entries
   */
  async clearExpiredCache(): Promise<void> {
    if (!this.db) {
      await this.initCache();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }

      const transaction = this.db.transaction(['features'], 'readwrite');
      const store = transaction.objectStore('features');
      const request = store.openCursor();
      const now = Date.now();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          if (now - cursor.value.timestamp > CACHE_TTL) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });
  }
}
