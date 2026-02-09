import { randomBytes } from 'crypto';

export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

export function generateRequestId(): string {
  return `req_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
