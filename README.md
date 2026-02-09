# Plumise Inference API

Decentralized AI inference gateway for Plumise chain. Routes inference requests from clients to the distributed Petals network with authentication, payment verification, and rate limiting.

## Features

- **Wallet-based Authentication**: EIP-712 signature verification with JWT tokens
- **Tier-based Access Control**: Free and Pro tiers with different model access
- **Rate Limiting**: 10 requests/hour for Free tier, unlimited for Pro
- **OpenAI-compatible API**: Standard inference and chat completion endpoints
- **WebSocket Support**: Real-time streaming inference via Socket.IO
- **Model Registry**: Track available models and serving nodes
- **Oracle Integration**: Receive metrics from Petals nodes

## Architecture

### Modules

- **InferenceModule**: Core inference routing to Petals network
- **AuthModule**: Wallet signature verification and JWT authentication
- **PaymentModule**: On-chain payment verification for Pro tier
- **RateLimitModule**: Tier-based rate limiting
- **ModelModule**: Model registry and node discovery
- **ChainModule**: Blockchain interaction with ethers.js
- **ReportModule**: Receive metrics from Petals nodes

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
PORT=3200
JWT_SECRET=your-jwt-secret

CHAIN_RPC_URL=http://localhost:26902
CHAIN_WS_URL=ws://localhost:26912
CHAIN_ID=41956

PETALS_API_URL=http://localhost:31330
ORACLE_API_KEY=your-oracle-api-key
```

## Running

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## API Endpoints

### Authentication

```
POST /api/v1/auth/nonce        - Get nonce for signing
POST /api/v1/auth/verify       - Verify signature, get JWT
GET  /api/v1/auth/me           - Get user profile
```

### Inference

```
POST /api/v1/inference         - Run text completion
POST /api/v1/inference/chat    - Run chat completion
GET  /api/v1/inference/stream  - Stream inference via SSE
WS   /ws/inference             - WebSocket streaming
```

### Models

```
GET  /api/v1/models            - List available models
GET  /api/v1/models/:id        - Get model details
```

### Health

```
GET  /                         - Health check
GET  /api/v1/health            - API health check
```

## API Documentation

Swagger UI: `http://localhost:3200/api/docs`

## Example Usage

### 1. Authentication

```javascript
// Get nonce
const { nonce, message } = await fetch('http://localhost:3200/api/v1/auth/nonce', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: '0x...' }),
}).then(r => r.json());

// Sign with wallet
const signature = await wallet.signMessage(message);

// Get JWT token
const { token } = await fetch('http://localhost:3200/api/v1/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: '0x...', signature }),
}).then(r => r.json());
```

### 2. Text Completion

```javascript
const response = await fetch('http://localhost:3200/api/v1/inference', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'meta-llama/Llama-3.1-8B',
    prompt: 'What is the capital of France?',
    max_tokens: 512,
    temperature: 0.7,
  }),
}).then(r => r.json());

console.log(response.choices[0].text);
```

### 3. Chat Completion

```javascript
const response = await fetch('http://localhost:3200/api/v1/inference/chat', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'meta-llama/Llama-3.1-8B',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is AI?' },
    ],
    max_tokens: 512,
  }),
}).then(r => r.json());

console.log(response.choices[0].message.content);
```

### 4. WebSocket Streaming

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3200/ws/inference', {
  auth: { token },
});

socket.on('connect', () => {
  socket.emit('inference_stream', {
    model: 'meta-llama/Llama-3.1-8B',
    prompt: 'Write a story about AI.',
    max_tokens: 1024,
  });
});

socket.on('inference_chunk', (data) => {
  process.stdout.write(data.data);
});

socket.on('inference_complete', () => {
  console.log('\nDone!');
  socket.close();
});
```

## Tiers

### Free Tier
- Rate limit: 10 requests/hour
- Models: Llama 3.1 8B, Mistral 7B
- Max tokens: 2048

### Pro Tier
- Rate limit: Unlimited
- Models: All (including Llama 3.1 70B)
- Max tokens: 4096

## Development

```bash
# Run tests
npm run test

# Lint
npm run lint

# Format
npm run format
```

## Tech Stack

- NestJS 10+ with TypeScript
- Passport + JWT for authentication
- Socket.IO for WebSocket
- ethers.js v6 for blockchain
- class-validator for DTOs
- Swagger/OpenAPI

## License

MIT
