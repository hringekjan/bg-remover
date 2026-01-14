import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { readFileSync, writeFileSync } from 'fs';

// Initialize clients
const novaClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const translationClient = new BedrockRuntimeClient({ region: 'us-west-2' });

interface TestResult {
  phase: string;
  model: string;
  success: boolean;
  data?: any;
  error?: string;
  timeMs: number;
}

const results: TestResult[] = [];

// Phase 1: Test Nova Canvas Background Removal
async function testNovaCanvas() {
  const startTime = Date.now();
  console.log('🔄 Testing Amazon Nova Canvas (Background Removal)...');
  
  try {
    const imagePath = '/Users/davideagle/Downloads/1000011962.webp';
    const imageBuffer = readFileSync(imagePath);
    const imageBase64 = imageBuffer.toString('base64');
    
    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-canvas-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        taskType: 'BACKGROUND_REMOVAL',
        backgroundRemovalParams: {
          image: imageBase64
        },
        imageGenerationConfig: {
          numberOfImages: 1,
          quality: 'premium',
          height: 1024,
          width: 1024
        }
      })
    });
    
    const response = await novaClient.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    
    // Save output image
    const outputBuffer = Buffer.from(result.images[0], 'base64');
    writeFileSync('/tmp/test-bg-removed.png', outputBuffer);
    
    results.push({
      phase: 'Background Removal',
      model: 'amazon.nova-canvas-v1:0',
      success: true,
      data: { outputPath: '/tmp/test-bg-removed.png', sizeBytes: outputBuffer.length },
      timeMs: Date.now() - startTime
    });
    
    console.log(`✅ Nova Canvas: Background removed in ${Date.now() - startTime}ms`);
    console.log(`   Output saved to: /tmp/test-bg-removed.png (${Math.round(outputBuffer.length / 1024)}KB)`);
  } catch (error: any) {
    results.push({
      phase: 'Background Removal',
      model: 'amazon.nova-canvas-v1:0',
      success: false,
      error: error.message,
      timeMs: Date.now() - startTime
    });
    console.error(`❌ Nova Canvas failed: ${error.message}`);
  }
}

// Phase 2: Test Mistral Pixtral Vision Analysis
async function testMistralPixtral() {
  const startTime = Date.now();
  console.log('\n🔄 Testing Mistral Pixtral Large (Vision Analysis)...');
  
  try {
    const imagePath = '/Users/davideagle/Downloads/1000011962.webp';
    const imageBuffer = readFileSync(imagePath);
    const imageBase64 = imageBuffer.toString('base64');
    
    const command = new InvokeModelCommand({
      modelId: 'us.mistral.pixtral-large-2502-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/webp',
                data: imageBase64
              }
            },
            {
              type: 'text',
              text: 'Analyze this product image and provide a detailed description in JSON format with these fields: description (2-3 sentences), category (e.g., Shirt, Dress, Shoes), color (primary color), features (array of key features), condition (New, Like New, Good, Fair). Be specific and accurate.'
            }
          ]
        }],
        max_tokens: 500,
        temperature: 0.3
      })
    });
    
    const response = await novaClient.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    const content = result.content[0].text;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const productData = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    
    results.push({
      phase: 'Vision Analysis',
      model: 'us.mistral.pixtral-large-2502-v1:0',
      success: true,
      data: productData,
      timeMs: Date.now() - startTime
    });
    
    console.log(`✅ Mistral Pixtral: Analysis complete in ${Date.now() - startTime}ms`);
    console.log(`   Category: ${productData.category || 'N/A'}`);
    console.log(`   Color: ${productData.color || 'N/A'}`);
    console.log(`   Description: ${productData.description?.substring(0, 80) || 'N/A'}...`);
  } catch (error: any) {
    results.push({
      phase: 'Vision Analysis',
      model: 'us.mistral.pixtral-large-2502-v1:0',
      success: false,
      error: error.message,
      timeMs: Date.now() - startTime
    });
    console.error(`❌ Mistral Pixtral failed: ${error.message}`);
  }
}

// Phase 3: Test GPT-OSS Icelandic Translation
async function testTranslation() {
  const startTime = Date.now();
  console.log('\n🔄 Testing GPT-OSS Safeguard 20B (Icelandic Translation)...');
  
  try {
    const englishDescription = results.find(r => r.phase === 'Vision Analysis')?.data?.description || 
      'A classic blue cotton shirt with buttons';
    
    const command = new ConverseCommand({
      modelId: 'openai.gpt-oss-safeguard-20b',
      messages: [{
        role: 'user',
        content: [{
          text: `Translate this product description to Icelandic. Keep the same tone and style. Only return the translation, no explanations.\n\n${englishDescription}`
        }]
      }],
      inferenceConfig: {
        maxTokens: 300,
        temperature: 0.3
      }
    });
    
    const response = await translationClient.send(command);
    const translation = response.output.message.content[0].text;
    
    results.push({
      phase: 'Translation',
      model: 'openai.gpt-oss-safeguard-20b',
      success: true,
      data: { original: englishDescription, translation },
      timeMs: Date.now() - startTime
    });
    
    console.log(`✅ GPT-OSS: Translation complete in ${Date.now() - startTime}ms`);
    console.log(`   English: ${englishDescription.substring(0, 60)}...`);
    console.log(`   Icelandic: ${translation.substring(0, 60)}...`);
  } catch (error: any) {
    results.push({
      phase: 'Translation',
      model: 'openai.gpt-oss-safeguard-20b',
      success: false,
      error: error.message,
      timeMs: Date.now() - startTime
    });
    console.error(`❌ GPT-OSS failed: ${error.message}`);
  }
}

// Run all tests
async function runTests() {
  console.log('🚀 Testing BG-Remover with REAL AWS Bedrock Models\n');
  console.log('━'.repeat(60));
  
  await testNovaCanvas();
  await testMistralPixtral();
  await testTranslation();
  
  console.log('\n' + '━'.repeat(60));
  console.log('\n📊 Test Results Summary:\n');
  
  results.forEach((result, idx) => {
    const icon = result.success ? '✅' : '❌';
    console.log(`${icon} ${result.phase} (${result.model})`);
    console.log(`   Time: ${result.timeMs}ms`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  });
  
  // Create final JSON output
  const finalOutput = {
    success: results.every(r => r.success),
    timestamp: new Date().toISOString(),
    modelsUsed: {
      backgroundRemoval: 'amazon.nova-canvas-v1:0',
      visionAnalysis: 'us.mistral.pixtral-large-2502-v1:0',
      translation: 'openai.gpt-oss-safeguard-20b'
    },
    performance: {
      totalTimeMs: results.reduce((sum, r) => sum + r.timeMs, 0),
      averagePerPhaseMs: Math.round(results.reduce((sum, r) => sum + r.timeMs, 0) / results.length)
    },
    results: results.map(r => ({
      phase: r.phase,
      model: r.model,
      success: r.success,
      data: r.data,
      error: r.error,
      processingTimeMs: r.timeMs
    }))
  };
  
  writeFileSync('/tmp/bedrock-test-results.json', JSON.stringify(finalOutput, null, 2));
  
  console.log('\n✅ Results saved to: /tmp/bedrock-test-results.json');
  console.log(`\n🎯 Overall Success: ${finalOutput.success ? 'PASS' : 'FAIL'}`);
  console.log(`⏱️  Total Time: ${finalOutput.performance.totalTimeMs}ms\n`);
}

runTests().catch(console.error);
