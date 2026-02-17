import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';

interface AgentUsage {
  tokensProcessed: number;
  requestCount: number;
  totalLatencyMs: number;
  uptimeStart: number;
  lastRecordedAt: number; // timestamp of last recordUsage() call
}

@Injectable()
export class UsageTrackerService implements OnModuleDestroy {
  private readonly logger = new Logger(UsageTrackerService.name);
  private readonly oracleUrl: string;
  private readonly oracleApiKey: string;
  private readonly agentUsage = new Map<string, AgentUsage>();
  private reportTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.oracleUrl = process.env.ORACLE_API_URL || '';
    this.oracleApiKey = process.env.ORACLE_API_KEY || '';

    if (this.oracleUrl && this.oracleApiKey) {
      this.reportTimer = setInterval(() => this.reportToOracle(), 10_000);
      this.logger.log(`Usage tracking enabled, reporting to ${this.oracleUrl}`);
    } else {
      this.logger.warn('Usage tracking disabled: ORACLE_API_URL or ORACLE_API_KEY not set');
    }
  }

  onModuleDestroy() {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
    }
  }

  recordUsage(agentAddress: string, tokens: number, latencyMs: number) {
    const addr = agentAddress.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    let usage = this.agentUsage.get(addr);
    if (!usage) {
      usage = {
        tokensProcessed: 0,
        requestCount: 0,
        totalLatencyMs: 0,
        uptimeStart: now,
        lastRecordedAt: now,
      };
      this.agentUsage.set(addr, usage);
    }
    usage.tokensProcessed += tokens;
    usage.requestCount += 1;
    usage.totalLatencyMs += latencyMs;
    usage.lastRecordedAt = now;
  }

  private async reportToOracle() {
    if (this.agentUsage.size === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const staleThreshold = 60; // remove agents inactive for 60s

    for (const [wallet, usage] of this.agentUsage) {
      // Skip and remove agents that haven't recorded new usage recently
      if (now - usage.lastRecordedAt > staleThreshold) {
        this.logger.log(`Removing stale agent usage: ${wallet} (inactive ${now - usage.lastRecordedAt}s)`);
        this.agentUsage.delete(wallet);
        continue;
      }

      try {
        const avgLatencyMs = usage.requestCount > 0
          ? Math.round(usage.totalLatencyMs / usage.requestCount)
          : 0;
        const uptimeSeconds = now - usage.uptimeStart;

        await axios.post(
          `${this.oracleUrl}/api/metrics`,
          {
            wallet,
            tokensProcessed: usage.tokensProcessed,
            requestCount: usage.requestCount,
            avgLatencyMs,
            uptimeSeconds,
            timestamp: now,
            signature: 'internal',
          },
          {
            headers: { 'x-api-key': this.oracleApiKey },
            timeout: 5000,
          },
        );

        this.logger.debug(
          `Reported usage for ${wallet}: ${usage.tokensProcessed} tokens, ${usage.requestCount} reqs`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to report usage for ${wallet}: ${error instanceof Error ? error.message : 'Unknown'}`,
        );
      }
    }
  }
}
