# Plumise Inference API

**[English](README.md) | [한국어](README.ko.md)**

Plumise AI Inference Gateway -- API gateway for the distributed Petals node network.

This is a **team-operated service** that provides an OpenAI-compatible API to end users, authenticates requests via wallet signatures, discovers active Petals nodes through the Oracle, and routes inference requests across the distributed network with load balancing and failover.

> **Note**: This service is operated by the Plumise team. If you want to contribute compute and earn PLM, see [plumise-petals](https://github.com/mikusnuz/plumise-petals) instead.

## Architecture

```
                                        +-----------------------+
                                        |    Plumise Oracle     |
                                        | (active node list)    |
                                        +----------+------------+
                                                   |
                                            node discovery
                                                   |
+----------+      +--------------------+           v            +------------------+
|  Client  | ---> | Inference API      | ---+-- route --------> | Petals Node A    |
| (wallet  |      | (this service)     |    |                   +------------------+
|  auth)   |      |                    |    +-- route --------> | Petals Node B    |
+----------+      | - Auth (JWT)       |    |                   +------------------+
                  | - Rate Limiting    |    +-- route --------> | Petals Node C    |
                  | - Node Router      |                        +------------------+
                  | - Metrics Reporter |
                  +--------------------+
```

For the full ecosystem architecture, see [plumise-petals/docs/ARCHITECTURE.md](https://github.com/mikusnuz/plumise-petals/blob/main/docs/ARCHITECTURE.md).

## Features

- **Wallet-based Authentication**: EIP-712 signature verification with JWT tokens
- **Tier-based Access Control**: Free and Pro tiers with different model access
- **Rate Limiting**: 10 requests/hour for Free tier, unlimited for Pro
- **OpenAI-compatible API**: Standard inference and chat completion endpoints
- **WebSocket Support**: Real-time streaming inference via Socket.IO
- **Node Discovery**: Automatic node discovery from Oracle or static config
- **Intelligent Routing**: Round-robin load balancing with health checks and failover
- **High Availability**: Automatic retry to healthy nodes on failure
- **Metrics Reporting**: Automatic token counting and latency tracking to Oracle
- **Docker Support**: Production-ready containerization

## Quick Start

```bash
git clone https://github.com/mikusnuz/plumise-inference-api.git
cd plumise-inference-api
cp .env.example .env
# Edit .env -- set JWT_SECRET, PRIVATE_KEY, ORACLE_API_URL
npm install
npm run start:dev
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3200` | API server port |
| `JWT_SECRET` | -- | **Required.** Secret for JWT token signing |
| `JWT_EXPIRATION` | `24h` | JWT token expiration time |
| `CHAIN_RPC_URL` | `http://localhost:26902` | Plumise chain RPC endpoint |
| `CHAIN_WS_URL` | `ws://localhost:26912` | Plumise chain WebSocket endpoint |
| `CHAIN_ID` | `41956` | Plumise chain ID |
| `ORACLE_API_URL` | `http://localhost:15481` | Oracle API for node discovery and metrics |
| `ORACLE_API_KEY` | -- | API key for Oracle communication |
| `NODE_URLS` | -- | Static Petals node URLs (comma-separated, fallback) |
| `PETALS_API_URL` | `http://localhost:31330` | Direct Petals API URL (single-node mode) |
| `PRIVATE_KEY` | -- | Private key for metrics signing |
| `FREE_TIER_LIMIT` | `10` | Free tier rate limit (requests/hour) |
| `FREE_TIER_MAX_TOKENS` | `2048` | Free tier max tokens per request |
| `PRO_TIER_MAX_TOKENS` | `4096` | Pro tier max tokens per request |
| `CORS_ORIGINS` | `http://localhost:3000` | Allowed CORS origins |

**Important**:
- `ORACLE_API_URL`: Gateway fetches active node list from Oracle
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
POST /api/v1/auth/nonce        - Get nonce for wallet signing
POST /api/v1/auth/verify       - Verify signature, get JWT token
GET  /api/v1/auth/me           - Get user profile (requires JWT)
```

### Inference

```
POST /api/v1/inference              - Run text completion (requires JWT)
POST /api/v1/inference/chat         - Run chat completion (requires JWT)
GET  /api/v1/inference/stream       - Stream inference via SSE (requires JWT)
WS   /ws/inference                  - WebSocket streaming (requires JWT)
```

### Nodes

```
GET  /api/v1/nodes                  - List active inference nodes
GET  /api/v1/nodes/:address/stats   - Get node statistics
```

### Models

```
GET  /api/v1/models                 - List available models (public)
GET  /api/v1/models/:id             - Get model details (requires JWT)
```

### Report (Internal)

```
POST /api/v1/report                 - Receive metrics from Petals nodes (API key)
GET  /api/v1/report/agents          - Get all agent reports (API key)
```

### Health

```
GET  /                         - Health check
GET  /api/v1/health            - API health check
```

### API Documentation

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
    model: 'bigscience/bloom-560m',
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
6. **Failover**: If node fails, automatically retry with next healthy node (up to 3 retries)
7. **Response Processing**: Parse Petals response, count tokens, measure latency
8. **Metrics Reporting**: Background job reports aggregated metrics to Oracle every 60s
9. **Response Return**: Send formatted OpenAI-compatible response to client

## Module Structure

```
src/
├── modules/
│   ├── auth/            # Wallet signature verification & JWT
│   ├── inference/       # Core inference routing
│   │   ├── inference.service.ts       # Business logic
│   │   ├── inference.controller.ts    # REST endpoints
│   │   ├── inference.gateway.ts       # WebSocket gateway
│   │   ├── node-router.service.ts     # Node discovery & load balancing
│   │   ├── petals-client.service.ts   # Petals HTTP client
│   │   └── metrics-reporter.service.ts # Metrics to Oracle
│   ├── model/           # Model registry
│   ├── payment/         # On-chain payment verification (Pro tier)
│   ├── rate-limit/      # Tier-based rate limiting
│   ├── chain/           # Blockchain interaction (ethers.js)
│   └── report/          # Receive metrics from Petals nodes
└── main.ts
```

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

## Related Projects

| Project | Description | Link |
|---------|-------------|------|
| **plumise-petals** | AI inference node (users/miners install this) | [GitHub](https://github.com/mikusnuz/plumise-petals) |
| **plumise-oracle** | Metrics aggregation, scoring, and on-chain reward reporting | [GitHub](https://github.com/mikusnuz/plumise-oracle) |
| **plumise** | Plumise chain node (geth fork with AI precompiles) | [GitHub](https://github.com/mikusnuz/plumise) |
| **plumise-contracts** | On-chain system contracts (RewardPool, AgentRegistry, etc.) | [GitHub](https://github.com/mikusnuz/plumise-contracts) |

## License

MIT
