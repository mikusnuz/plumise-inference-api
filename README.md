# Plumise Inference API

Decentralized AI inference API Gateway for Plumise chain. Routes inference requests from clients to distributed Petals inference nodes with authentication, payment verification, rate limiting, and automatic failover.

## Features

- **Wallet-based Authentication**: EIP-712 signature verification with JWT tokens
- **Tier-based Access Control**: Free and Pro tiers with different model access
- **Rate Limiting**: 10 requests/hour for Free tier, unlimited for Pro
- **OpenAI-compatible API**: Standard inference and chat completion endpoints
- **WebSocket Support**: Real-time streaming inference via Socket.IO
- **Model Registry**: Track available models and serving nodes
- **Node Discovery**: Automatic node discovery from Oracle or static config
- **Intelligent Routing**: Round-robin load balancing with health checks and failover
- **High Availability**: Automatic retry to healthy nodes on failure
- **Docker Support**: Production-ready containerization

## Architecture

### Modules

- **InferenceModule**: Core inference routing with NodeRouter
- **NodeRouterService**: Intelligent request routing with health checks and failover
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

# Node Discovery (either Oracle or static list)
ORACLE_API_URL=http://localhost:15481
NODE_URLS=http://localhost:31330,http://192.168.0.200:31330

# Rate Limiting
FREE_TIER_LIMIT=10
FREE_TIER_MAX_TOKENS=2048
PRO_TIER_MAX_TOKENS=4096
```

**Important**:
- `ORACLE_API_URL`: Optional. Gateway fetches active node list from Oracle
- `NODE_URLS`: Comma-separated list of static Petals node URLs (fallback)
- At least one of `ORACLE_API_URL` or `NODE_URLS` must be configured
- Gateway automatically performs health checks and routes to healthy nodes

## Running

### Development

```bash
# Start in development mode
npm run start:dev
```

### Production

```bash
# Using npm
npm run build
npm run start:prod

# Using Docker
npm run docker:build
npm run docker:up

# View logs
npm run docker:logs

# Stop
npm run docker:down
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
POST /api/v1/inference              - Run text completion
POST /api/v1/inference/chat         - Run chat completion
GET  /api/v1/inference/stream       - Stream inference via SSE
WS   /ws/inference                  - WebSocket streaming
```

### Nodes

```
GET  /api/v1/nodes                  - List active inference nodes
GET  /api/v1/nodes/:address/stats   - Get node statistics
```

### Models

```
GET  /api/v1/models                 - List available models
GET  /api/v1/models/:id             - Get model details
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
    model: 'bigscience/bloom-560m',  // or 'meta-llama/Llama-3.1-8B'
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
- Models: BLOOM 560M, Llama 3.1 8B, Mistral 7B
- Max tokens: 2048

### Pro Tier
- Rate limit: Unlimited
- Models: All (including Llama 3.1 70B)
- Max tokens: 4096

## How It Works

1. **Client Authentication**: Users authenticate with wallet signature to get JWT token
2. **Inference Request**: Client sends inference request with JWT authorization
3. **Rate Limiting**: API checks user's tier and rate limit
4. **Node Selection**: NodeRouter selects healthy node using round-robin
5. **Request Forwarding**: Forward request to selected Petals node
6. **Failover**: If node fails, automatically retry with next healthy node
7. **Response Return**: Send formatted OpenAI-compatible response to client

### Key Components

- **NodeRouterService**: Node discovery, health checks, and intelligent routing
- **InferenceService**: Core business logic for inference orchestration
- **InferenceGateway**: WebSocket gateway for real-time streaming
- **AuthGuard & RateLimitGuard**: Request validation and rate limiting

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
