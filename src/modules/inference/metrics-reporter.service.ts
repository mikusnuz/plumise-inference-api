import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import axios from 'axios';
import { ethers } from 'ethers';

interface MetricsPayload {
  agent: string;
  processed_tokens: number;
  avg_latency_ms: number;
  uptime_seconds: number;
  tasks_completed: number;
  timestamp: number;
  signature?: string;
}

@Injectable()
export class MetricsReporterService {
  private readonly logger = new Logger(MetricsReporterService.name);
  private readonly oracleApiUrl = process.env.ORACLE_API_URL || 'http://localhost:15481';
  private readonly oracleApiKey = process.env.ORACLE_API_KEY;
  private readonly privateKey = process.env.PRIVATE_KEY;
  private wallet: ethers.Wallet | null = null;

  private totalTokens = 0;
  private totalRequests = 0;
  private totalLatencyMs = 0;
  private readonly startTime = Date.now();

  constructor() {
    if (this.privateKey) {
      try {
        this.wallet = new ethers.Wallet(this.privateKey);
        this.logger.log(`MetricsReporter initialized for agent ${this.wallet.address}`);
      } catch (error) {
        this.logger.error('Failed to initialize wallet for metrics reporting', error);
      }
    } else {
      this.logger.warn('PRIVATE_KEY not set, metrics will not be signed');
    }
  }

  recordInference(tokens: number, latencyMs: number) {
    this.totalTokens += tokens;
    this.totalRequests++;
    this.totalLatencyMs += latencyMs;
  }

  @Interval(60000)
  async reportToOracle() {
    if (!this.wallet) {
      this.logger.warn('Wallet not initialized, skipping metrics report');
      return;
    }

    if (this.totalRequests === 0) {
      this.logger.debug('No requests to report');
      return;
    }

    try {
      const payload: MetricsPayload = {
        agent: this.wallet.address,
        processed_tokens: this.totalTokens,
        avg_latency_ms: this.totalLatencyMs / this.totalRequests,
        uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
        tasks_completed: this.totalRequests,
        timestamp: Math.floor(Date.now() / 1000),
      };

      const message = JSON.stringify({
        agent: payload.agent,
        processed_tokens: payload.processed_tokens,
        timestamp: payload.timestamp,
      });

      const signature = await this.wallet.signMessage(message);
      payload.signature = signature;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.oracleApiKey) {
        headers['x-api-key'] = this.oracleApiKey;
      }

      await axios.post(`${this.oracleApiUrl}/api/metrics`, payload, {
        headers,
        timeout: 5000,
      });

      this.logger.log(
        `Reported metrics: ${this.totalRequests} requests, ` +
        `${this.totalTokens} tokens, ` +
        `${(payload.avg_latency_ms).toFixed(2)}ms avg latency`,
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          this.logger.debug('Oracle API not available, skipping metrics report');
        } else {
          this.logger.error(`Failed to report metrics: ${error.message}`);
        }
      } else {
        this.logger.error('Failed to report metrics', error);
      }
    }
  }

  getStats() {
    return {
      totalTokens: this.totalTokens,
      totalRequests: this.totalRequests,
      avgLatencyMs: this.totalRequests > 0 ? this.totalLatencyMs / this.totalRequests : 0,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }
}
