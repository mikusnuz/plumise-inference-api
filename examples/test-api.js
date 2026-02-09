const fetch = require('node-fetch');

const API_URL = 'http://localhost:3200';

async function testAPI() {
  console.log('Testing Plumise Inference API...\n');

  // 1. Health check
  console.log('1. Health check');
  const health = await fetch(`${API_URL}/api/v1/health`).then(r => r.json());
  console.log('Health:', health);
  console.log('');

  // 2. List models
  console.log('2. List available models');
  const models = await fetch(`${API_URL}/api/v1/models`).then(r => r.json());
  console.log('Models:', JSON.stringify(models, null, 2));
  console.log('');

  console.log('✅ API is running!');
  console.log('📚 Swagger docs: http://localhost:3200/api/docs');
}

testAPI().catch(err => {
  console.error('❌ Error:', err.message);
  console.log('\nMake sure the API is running:');
  console.log('  npm run start:dev');
});
