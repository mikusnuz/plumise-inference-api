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

/**
 * Strip internal channel tokens from model output.
 * Legacy models used multi-channel format (analysis/commentary/final).
 * Only the "final" channel content should be shown to users.
 */
export function stripChannelTokens(content: string): string {
  if (!content) return content;

  // If the response contains a final channel marker, extract only that content
  const finalMarker = '<|channel|>final<|message|>';
  const lastFinalIdx = content.lastIndexOf(finalMarker);
  if (lastFinalIdx !== -1) {
    let extracted = content.substring(lastFinalIdx + finalMarker.length);
    // Remove trailing special tokens
    for (const token of ['<|end|>', '<|return|>', '<|start|>']) {
      const idx = extracted.indexOf(token);
      if (idx !== -1) {
        extracted = extracted.substring(0, idx);
      }
    }
    return extracted.trim();
  }

  // Fallback: strip any channel/control tokens (only trim if tokens were actually found)
  const hasSpecialTokens = /<\|(channel|start|end|return|call)\|>/.test(content);
  if (!hasSpecialTokens) return content;

  return content
    .replace(/<\|channel\|>[^<]*<\|message\|>/g, '')
    .replace(/<\|start\|>[^<]*/g, '')
    .replace(/<\|end\|>/g, '')
    .replace(/<\|return\|>/g, '')
    .replace(/<\|call\|>/g, '')
    .trim();
}
