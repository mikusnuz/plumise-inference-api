import { Injectable, Logger } from '@nestjs/common';
import { UserTier } from '../../common/interfaces';

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly users = new Map<string, UserTier>();

  private readonly FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_LIMIT || '10');
  private readonly FREE_TIER_WINDOW = parseInt(process.env.FREE_TIER_WINDOW || '3600') * 1000;

  checkRateLimit(address: string, tier: 'free' | 'pro'): boolean {
    if (tier === 'pro') {
      return true;
    }

    const normalizedAddress = address.toLowerCase();
    let userTier = this.users.get(normalizedAddress);

    const now = new Date();

    if (!userTier) {
      userTier = {
        address: normalizedAddress,
        tier: 'free',
        usageCount: 0,
        lastReset: now,
      };
      this.users.set(normalizedAddress, userTier);
    }

    const timeSinceReset = now.getTime() - userTier.lastReset.getTime();

    if (timeSinceReset > this.FREE_TIER_WINDOW) {
      userTier.usageCount = 0;
      userTier.lastReset = now;
    }

    if (userTier.usageCount >= this.FREE_TIER_LIMIT) {
      return false;
    }

    return true;
  }

  incrementUsage(address: string): void {
    const normalizedAddress = address.toLowerCase();
    const userTier = this.users.get(normalizedAddress);

    if (userTier) {
      userTier.usageCount++;
    }
  }

  getUsageStats(address: string): { used: number; limit: number; resetAt: Date } | null {
    const normalizedAddress = address.toLowerCase();
    const userTier = this.users.get(normalizedAddress);

    if (!userTier) {
      return null;
    }

    const resetAt = new Date(userTier.lastReset.getTime() + this.FREE_TIER_WINDOW);

    return {
      used: userTier.usageCount,
      limit: this.FREE_TIER_LIMIT,
      resetAt,
    };
  }
}
