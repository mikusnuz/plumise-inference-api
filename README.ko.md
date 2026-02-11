# Plumise Inference API

**[English](README.md) | [한국어](README.ko.md)**

Plumise AI 추론 게이트웨이 -- 분산 Petals 노드 네트워크를 위한 API 게이트웨이.

이 서비스는 **팀이 운영하는 서비스**로, 최종 사용자에게 OpenAI 호환 API를 제공하고, 지갑 서명으로 요청을 인증하며, Oracle을 통해 활성 Petals 노드를 탐색하고, 로드 밸런싱과 장애 조치를 통해 분산 네트워크에 추론 요청을 라우팅합니다.

> **참고**: 이 서비스는 Plumise 팀이 운영합니다. 컴퓨팅을 기여하고 PLM을 채굴하려면 [plumise-petals](https://github.com/mikusnuz/plumise-petals)를 참조하세요.

## 아키텍처

```
                                        +-----------------------+
                                        |    Plumise Oracle     |
                                        | (활성 노드 목록)       |
                                        +----------+------------+
                                                   |
                                             노드 디스커버리
                                                   |
+----------+      +--------------------+           v            +------------------+
| 클라이언트 | ---> | Inference API     | ---+-- 라우팅 -------> | Petals Node A    |
| (지갑     |      | (이 서비스)        |    |                   +------------------+
|  인증)    |      |                    |    +-- 라우팅 -------> | Petals Node B    |
+----------+      | - 인증 (JWT)       |    |                   +------------------+
                  | - 속도 제한        |    +-- 라우팅 -------> | Petals Node C    |
                  | - 노드 라우터      |                        +------------------+
                  | - 메트릭 리포터    |
                  +--------------------+
```

전체 생태계 아키텍처는 [plumise-petals/docs/ARCHITECTURE.md](https://github.com/mikusnuz/plumise-petals/blob/main/docs/ARCHITECTURE.md)를 참조하세요.

## 주요 기능

- **지갑 기반 인증**: EIP-712 서명 검증 + JWT 토큰
- **티어별 접근 제어**: Free/Pro 티어별 모델 접근 차등
- **속도 제한**: Free 티어 시간당 10회, Pro 무제한
- **OpenAI 호환 API**: 표준 추론 및 채팅 완성 엔드포인트
- **WebSocket 지원**: Socket.IO를 통한 실시간 스트리밍 추론
- **노드 디스커버리**: Oracle 또는 정적 설정을 통한 자동 노드 탐색
- **지능형 라우팅**: 헬스체크 기반 라운드 로빈 로드 밸런싱 + 장애 조치
- **고가용성**: 노드 장애 시 자동으로 정상 노드에 재시도
- **메트릭 보고**: 토큰 수 자동 집계 및 레이턴시 추적 후 Oracle에 보고
- **Docker 지원**: 프로덕션 레디 컨테이너화

## 빠른 시작

```bash
git clone https://github.com/mikusnuz/plumise-inference-api.git
cd plumise-inference-api
cp .env.example .env
# .env 편집 -- JWT_SECRET, PRIVATE_KEY, ORACLE_API_URL 설정
npm install
npm run start:dev
```

## 설정

`.env.example`을 `.env`로 복사하고 설정합니다:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3200` | API 서버 포트 |
| `JWT_SECRET` | -- | **필수.** JWT 토큰 서명 시크릿 |
| `JWT_EXPIRATION` | `24h` | JWT 토큰 만료 시간 |
| `CHAIN_RPC_URL` | `http://localhost:26902` | Plumise 체인 RPC 엔드포인트 |
| `CHAIN_WS_URL` | `ws://localhost:26912` | Plumise 체인 WebSocket 엔드포인트 |
| `CHAIN_ID` | `41956` | Plumise 체인 ID |
| `ORACLE_API_URL` | `http://localhost:15481` | 노드 디스커버리 및 메트릭용 Oracle API |
| `ORACLE_API_KEY` | -- | Oracle 통신용 API 키 |
| `NODE_URLS` | -- | 정적 Petals 노드 URL (쉼표 구분, 대체) |
| `PETALS_API_URL` | `http://localhost:31330` | 직접 Petals API URL (단일 노드 모드) |
| `PRIVATE_KEY` | -- | 메트릭 서명용 프라이빗 키 |
| `FREE_TIER_LIMIT` | `10` | Free 티어 속도 제한 (요청/시간) |
| `FREE_TIER_MAX_TOKENS` | `2048` | Free 티어 요청당 최대 토큰 |
| `PRO_TIER_MAX_TOKENS` | `4096` | Pro 티어 요청당 최대 토큰 |
| `CORS_ORIGINS` | `http://localhost:3000` | 허용 CORS 오리진 |

**중요**:
- `ORACLE_API_URL`: 게이트웨이가 Oracle에서 활성 노드 목록을 조회
- `NODE_URLS`: 정적 Petals 노드 URL 목록 (쉼표 구분, 대체용)
- `ORACLE_API_URL` 또는 `NODE_URLS` 중 하나 이상 설정 필요
- 게이트웨이는 자동으로 헬스체크를 수행하고 정상 노드로 라우팅

## 실행

### 개발

```bash
# 개발 모드로 시작
npm run start:dev
```

### 프로덕션

```bash
# npm 사용
npm run build
npm run start:prod

# Docker 사용
npm run docker:build
npm run docker:up

# 로그 확인
npm run docker:logs

# 중지
npm run docker:down
```

## API 엔드포인트

### 인증

```
POST /api/v1/auth/nonce        - 지갑 서명용 논스 발급
POST /api/v1/auth/verify       - 서명 검증, JWT 토큰 발급
GET  /api/v1/auth/me           - 사용자 프로필 조회 (JWT 필요)
```

### 추론

```
POST /api/v1/inference              - 텍스트 완성 실행 (JWT 필요)
POST /api/v1/inference/chat         - 채팅 완성 실행 (JWT 필요)
GET  /api/v1/inference/stream       - SSE를 통한 스트리밍 추론 (JWT 필요)
WS   /ws/inference                  - WebSocket 스트리밍 (JWT 필요)
```

### 노드

```
GET  /api/v1/nodes                  - 활성 추론 노드 목록
GET  /api/v1/nodes/:address/stats   - 노드 통계 조회
```

### 모델

```
GET  /api/v1/models                 - 사용 가능한 모델 목록 (공개)
GET  /api/v1/models/:id             - 모델 상세 정보 (JWT 필요)
```

### 리포트 (내부)

```
POST /api/v1/report                 - Petals 노드에서 메트릭 수신 (API 키)
GET  /api/v1/report/agents          - 전체 에이전트 리포트 조회 (API 키)
```

### 헬스

```
GET  /                         - 헬스 체크
GET  /api/v1/health            - API 헬스 체크
```

### API 문서

Swagger UI: `http://localhost:3200/api/docs`

## 사용 예시

### 1. 인증

```javascript
// 논스 발급
const { nonce, message } = await fetch('http://localhost:3200/api/v1/auth/nonce', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: '0x...' }),
}).then(r => r.json());

// 지갑으로 서명
const signature = await wallet.signMessage(message);

// JWT 토큰 발급
const { token } = await fetch('http://localhost:3200/api/v1/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: '0x...', signature }),
}).then(r => r.json());
```

### 2. 텍스트 완성

```javascript
const response = await fetch('http://localhost:3200/api/v1/inference', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'bigscience/bloom-560m',
    prompt: '프랑스의 수도는?',
    max_tokens: 512,
    temperature: 0.7,
  }),
}).then(r => r.json());

console.log(response.choices[0].text);
```

### 3. 채팅 완성

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
      { role: 'system', content: '당신은 유용한 AI 어시스턴트입니다.' },
      { role: 'user', content: 'AI란 무엇인가요?' },
    ],
    max_tokens: 512,
  }),
}).then(r => r.json());

console.log(response.choices[0].message.content);
```

### 4. WebSocket 스트리밍

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3200/ws/inference', {
  auth: { token },
});

socket.on('connect', () => {
  socket.emit('inference_stream', {
    model: 'meta-llama/Llama-3.1-8B',
    prompt: 'AI에 대한 이야기를 써주세요.',
    max_tokens: 1024,
  });
});

socket.on('inference_chunk', (data) => {
  process.stdout.write(data.data);
});

socket.on('inference_complete', () => {
  console.log('\n완료!');
  socket.close();
});
```

## PLM 결제 시스템

Inference API는 **InferencePayment** 스마트 컨트랙트와 통합되어 AI 추론에 대한 온체인 결제를 지원합니다.

### 결제 동작 원리

1. **예치**: 사용자가 InferencePayment 컨트랙트에 PLM을 예치하여 Pro 티어를 잠금 해제합니다.
2. **추론**: Pro 사용자가 추론 요청을 하면, 게이트웨이는 컨트랙트의 `useCredits()`를 호출하여 사용량에 따라 토큰을 차감합니다 (기본값: 1000 토큰당 0.001 PLM).
3. **수수료 징수**: 차감된 PLM은 Foundation Treasury (0x1001)로 전송됩니다.
4. **잔액 확인**: 사용자는 `/api/v1/auth/me` 엔드포인트를 통해 잔액과 티어 상태를 확인할 수 있습니다.

### 티어 결정

| 티어 | 요구사항 | 접근 권한 |
|------|----------|-----------|
| **Free** | 예치 불필요 | 시간당 10회, 기본 모델, 최대 2048 토큰 |
| **Pro** | 최소 100 PLM 예치 | 무제한 요청, 모든 모델, 최대 4096 토큰 |

Pro 티어는 InferencePayment 컨트랙트의 `getUserTier()`를 쿼리하여 온체인에서 결정됩니다. 게이트웨이는 티어 상태를 5분간 캐시합니다.

### 결제 엔드포인트

```
GET  /api/v1/payment/balance    - PLM 잔액 및 티어 조회 (JWT 필요)
POST /api/v1/payment/deposit    - PLM 예치 안내 (JWT 필요)
```

> **참고**: 예치 및 인출은 InferencePayment 컨트랙트를 통해 직접 온체인에서 이루어집니다. API는 잔액/티어 상태만 읽습니다.

### 설정

`.env`에서 `INFERENCE_PAYMENT_ADDRESS`를 설정하여 결제 시스템을 활성화합니다. 이 주소가 없으면 게이트웨이는 레거시 티어 시스템으로 폴백합니다 (모든 사용자가 Free 티어).

## 티어

### Free 티어
- 속도 제한: 시간당 10회
- 모델: BLOOM 560M, Llama 3.1 8B, Mistral 7B
- 최대 토큰: 2048

### Pro 티어
- 속도 제한: 무제한
- 모델: 전체 (Llama 3.1 70B 포함)
- 최대 토큰: 4096

## 동작 원리

1. **클라이언트 인증**: 지갑 서명으로 인증 후 JWT 토큰 발급
2. **추론 요청**: JWT 인증 헤더와 함께 추론 요청 전송
3. **티어 및 속도 제한**: API가 사용자의 티어 (InferencePayment 컨트랙트 조회)와 속도 제한 확인
4. **노드 선택**: NodeRouter가 라운드 로빈으로 정상 노드 선택
5. **요청 전달**: 선택된 Petals 노드에 요청 전달
6. **장애 조치**: 노드 장애 시 다음 정상 노드에 자동 재시도 (최대 3회)
7. **응답 처리**: Petals 응답 파싱, 토큰 수 집계, 레이턴시 측정
8. **크레딧 차감**: Pro 티어 사용자의 경우, 온체인 `useCredits()`를 통해 PLM 크레딧 차감
9. **메트릭 보고**: 백그라운드 작업이 60초마다 집계된 메트릭을 Oracle에 보고
10. **응답 반환**: OpenAI 호환 형식으로 포매팅된 응답을 클라이언트에 반환

## 모듈 구조

```
src/
├── modules/
│   ├── auth/            # 지갑 서명 검증 및 JWT
│   ├── inference/       # 핵심 추론 라우팅
│   │   ├── inference.service.ts       # 비즈니스 로직
│   │   ├── inference.controller.ts    # REST 엔드포인트
│   │   ├── inference.gateway.ts       # WebSocket 게이트웨이
│   │   ├── node-router.service.ts     # 노드 디스커버리 및 로드 밸런싱
│   │   ├── petals-client.service.ts   # Petals HTTP 클라이언트
│   │   └── metrics-reporter.service.ts # Oracle 메트릭 보고
│   ├── model/           # 모델 레지스트리
│   ├── payment/         # 온체인 결제 검증 (Pro 티어)
│   ├── rate-limit/      # 티어별 속도 제한
│   ├── chain/           # 블록체인 상호작용 (ethers.js)
│   └── report/          # Petals 노드 메트릭 수신
└── main.ts
```

## 개발

```bash
# 테스트 실행
npm run test

# 린트
npm run lint

# 포맷
npm run format
```

## 기술 스택

- NestJS 10+ with TypeScript
- Passport + JWT 인증
- Socket.IO WebSocket
- ethers.js v6 블록체인
- class-validator DTO 검증
- Swagger/OpenAPI

## 관련 프로젝트

| 프로젝트 | 설명 | 링크 |
|---------|------|------|
| **plumise-petals** | AI 추론 노드 (사용자/채굴자가 설치) | [GitHub](https://github.com/mikusnuz/plumise-petals) |
| **plumise-oracle** | 메트릭 수집, 스코어링, 온체인 보상 보고 | [GitHub](https://github.com/mikusnuz/plumise-oracle) |
| **plumise** | Plumise 체인 노드 (AI 프리컴파일 포함 geth 포크) | [GitHub](https://github.com/mikusnuz/plumise) |
| **plumise-contracts** | 온체인 시스템 컨트랙트 (RewardPool, AgentRegistry 등) | [GitHub](https://github.com/mikusnuz/plumise-contracts) |

## 라이선스

MIT
