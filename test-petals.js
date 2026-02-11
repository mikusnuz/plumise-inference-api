const axios = require('axios');

const PETALS_API_URL = process.env.PETALS_API_URL || 'http://localhost:31330';

async function testPetalsConnection() {
  console.log(`Testing Petals connection to ${PETALS_API_URL}...`);

  try {
    const response = await axios.post(
      `${PETALS_API_URL}/api/v1/generate`,
      {
        inputs: 'Hello! How are you today?',
        parameters: {
          max_new_tokens: 50,
          temperature: 0.7,
          top_p: 0.9,
          do_sample: true,
        },
      },
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('\n✅ Petals API is working!\n');
    console.log('Response:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n');
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('\n❌ Cannot connect to Petals server.');
      console.error(`   Make sure Petals is running at ${PETALS_API_URL}\n`);
    } else if (error.response) {
      console.error('\n❌ Petals API error:');
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data, null, 2)}\n`);
    } else {
      console.error('\n❌ Unexpected error:', error.message, '\n');
    }
    process.exit(1);
  }
}

testPetalsConnection();
