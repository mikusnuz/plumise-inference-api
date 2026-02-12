export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceRequest {
  model: string;
  prompt?: string;
  messages?: ChatMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface InferenceResponse {
  id: string;
  model: string;
  choices: {
    text?: string;
    message?: ChatMessage;
    finish_reason: 'stop' | 'length';
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  max_tokens: number;
  tier: 'free' | 'pro';
  nodes: number;
  status: 'available' | 'degraded' | 'offline';
  totalLayers?: number;
}

export interface JwtPayload {
  address: string;
  iat?: number;
  exp?: number;
}

export interface UserTier {
  address: string;
  tier: 'free' | 'pro';
  credits?: number;
  usageCount: number;
  lastReset: Date;
}
