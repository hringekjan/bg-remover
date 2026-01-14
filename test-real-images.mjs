// Integration test for bg-remover pipeline with real images

import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

// Adjust these imports according to your project structure
import { validateImage } from './src/validation.js'; // validation step
import { generateBatchEmbeddings } from './src/batch-embeddings.js'; // embeddings step
import { Cache } from './src/cache.js'; // simple in‑memory cache implementation
import { clusterImages } from './src/parallel-clustering.js'; // clustering step

const IMAGES_DIR = '/Users/davideagle/Downloads'; // folder with test images
const MAX_IMAGES = 10; // number of images to process

async function main() {
  const startTime = performance.now();

  // 1️⃣ Load image files
  const allFiles = fs.readdirSync(IMAGES_DIR);
  const imageFiles = allFiles
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .slice(0, MAX_IMAGES);

  if (imageFiles.length === 0) {
    throw new Error('No image files found in the test directory');
  }

  const images = imageFiles.map((filename) => {
    const filePath = path.join(IMAGES_DIR, filename);
    const buffer = fs.readFileSync(filePath);
    return { filename, buffer };
  });

  // 2️⃣ Validation step
  for (const img of images) {
    const isValid = await validateImage(img.buffer);
    if (!isValid) {
      throw new Error(`Validation failed for image ${img.filename}`);
    }
  }

  // 3️⃣ Generate embeddings (batch mode)
  const rawEmbeddings = await generateBatchEmbeddings(images.map((i) => i.buffer));

  // 4️⃣ Cache embeddings
  const cache = new Cache();
  let cacheHits = 0;
  let cacheMisses = 0;
  const embeddings = rawEmbeddings.map((emb, idx) => {
    const key = images[idx].filename;
    const cached = cache.get(key);
    if (cached) {
      cacheHits++;
      return cached;
    }
    cacheMisses++;
    cache.set(key, emb);
    return emb;
  });

  // 5️⃣ Cluster images based on embeddings
  const clusters = await clusterImages(embeddings);

  const totalTime = Math.round(performance.now() - startTime);

  // 6️⃣ Report results
  const report = {
    images_processed: images.length,
    embeddings_generated: rawEmbeddings.length,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
    clusters_found: clusters.length,
    total_time_ms: totalTime,
    status: 'success',
  };

  // Write JSON report to file
  const reportPath = path.resolve('integration-test-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('Integration test completed. Report:');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
