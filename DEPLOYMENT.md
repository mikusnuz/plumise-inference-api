# Deployment Guide

## Prerequisites

1. **Petals Server Running**: Ensure Petals server is running and accessible
   ```bash
   # Test Petals connection
   npm run test:petals
   ```

2. **Environment Variables**: Configure `.env` file with all required variables
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Oracle API (Optional)**: If you want metrics reporting to work, ensure Oracle is running at `ORACLE_API_URL`

## Local Development

```bash
# Install dependencies
npm install

# Test Petals connection
npm run test:petals

# Build TypeScript
npm run build

# Start in development mode
npm run start:dev
```

The API will be available at `http://localhost:3200`

## Docker Deployment

### Build and Run

```bash
# Build Docker image
npm run docker:build

# Start container
npm run docker:up

# View logs
npm run docker:logs

# Stop container
npm run docker:down
```

### Manual Docker Commands

```bash
# Build
docker build -t plumise-inference-api .

# Run
docker run -d \
  --name plumise-inference-api \
  --network host \
  --env-file .env \
  plumise-inference-api

# Logs
docker logs -f plumise-inference-api

# Stop
docker stop plumise-inference-api
docker rm plumise-inference-api
```

## Server Deployment (Production)

### Option 1: Docker Compose (Recommended)

```bash
# On server-1 or server-2
cd /opt/plumise-inference-api
git pull
npm run docker:build
npm run docker:up
```

### Option 2: PM2

```bash
# On server-1 or server-2
cd /opt/plumise-inference-api
git pull
npm install
npm run build

# Start with PM2
pm2 start dist/main.js --name plumise-inference-api
pm2 save
```

## Environment Variables for Production

```env
PORT=3200
NODE_ENV=production

# JWT Secret (CHANGE THIS!)
JWT_SECRET=plumise-inference-prod-secret-$(openssl rand -hex 32)

# Plumise Chain (server-1 local RPC)
CHAIN_RPC_URL=http://localhost:26902
CHAIN_WS_URL=ws://localhost:26912
CHAIN_ID=41956

# Petals Network
PETALS_API_URL=http://localhost:31330

# Oracle
ORACLE_API_URL=http://localhost:15481
ORACLE_API_KEY=<your-oracle-key>

# Private Key (for metrics signing)
PRIVATE_KEY=<your-private-key>

# CORS
CORS_ORIGINS=https://dashboard.plumise.com,https://plumise.com
```

## Health Checks

```bash
# API health
curl http://localhost:3200/health

# Models list
curl http://localhost:3200/api/v1/models

# Metrics (admin only, requires Oracle API key)
curl -H "x-api-key: your-oracle-key" http://localhost:3200/api/v1/report/metrics
```

## Monitoring

### Logs

```bash
# Docker
docker logs -f plumise-inference-api

# PM2
pm2 logs plumise-inference-api
```

### Metrics

The MetricsReporterService automatically reports to Oracle every 60 seconds:
- Total processed tokens
- Average latency (ms)
- Uptime (seconds)
- Tasks completed

Check Oracle dashboard for metrics visualization.

## Troubleshooting

### Petals Connection Refused

```bash
# Check if Petals is running
curl -X POST http://localhost:31330/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"inputs": "test", "parameters": {"max_new_tokens": 10}}'

# If not, start Petals server first
```

### JWT Token Issues

- Ensure `JWT_SECRET` is set and matches between restarts
- Token expires after 24 hours by default (configurable via `JWT_EXPIRATION`)

### Rate Limit Not Working

- Rate limit state is in-memory, resets on restart
- For persistent rate limiting, implement Redis backend

### Metrics Not Reporting

- Check `ORACLE_API_URL` is correct
- Check `ORACLE_API_KEY` matches Oracle server
- Check `PRIVATE_KEY` is valid for signing
- View logs for "Failed to report metrics" errors

## Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name inference-api.plumise.com;

    ssl_certificate /etc/letsencrypt/live/plumise.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/plumise.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /ws/ {
        proxy_pass http://localhost:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

## Security Checklist

- [ ] Change `JWT_SECRET` to strong random value
- [ ] Change `ORACLE_API_KEY` to strong random value
- [ ] Use dedicated `PRIVATE_KEY` for production
- [ ] Restrict `CORS_ORIGINS` to known domains only
- [ ] Enable HTTPS via reverse proxy
- [ ] Keep dependencies updated (`npm audit`)
- [ ] Monitor logs for suspicious activity
- [ ] Implement IP rate limiting at reverse proxy level
