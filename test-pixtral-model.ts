import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

async function testPixtralModel() {
  const client = new BedrockRuntimeClient({ region: 'us-west-2' });
  const modelId = 'us.mistral.pixtral-large-2502-v1:0';

  const payload = {
    messages: [{
      role: 'user',
      content: 'Describe this product: A blue mug'
    }],
    max_tokens: 100,
    temperature: 0.7
  };

  try {
    console.log(`\n🧪 Testing cross-region model: ${modelId}`);
    console.log(`📍 Client region: us-west-2`);
    console.log(`🎯 Lambda region: eu-west-1\n`);
    
    const command = new InvokeModelCommand({
      modelId,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      accept: 'application/json'
    });
    
    const startTime = Date.now();
    const response = await client.send(command);
    const latency = Date.now() - startTime;
    
    const result = JSON.parse(new TextDecoder().decode(response.body));
    
    console.log(`✅ Model test PASSED (${latency}ms)`);
    console.log('Response:', JSON.stringify(result, null, 2));
    return true;
  } catch (error: any) {
    console.log('❌ Model test FAILED');
    console.error('Error:', error.message);
    if (error.Code) console.error('Code:', error.Code);
    return false;
  }
}

testPixtralModel().then(success => process.exit(success ? 0 : 1));
