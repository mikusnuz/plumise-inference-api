import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import axios from 'axios';
import { ethers } from 'ethers';

interface MetricsPayload {
  wallet: string;
  tokensProcessed: number;
  avgLatencyMs: number;
  requestCount: number;
  uptimeSeconds: number;
  signature: string;
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

    const tokensProcessed = this.totalTokens;
    const requestCount = this.totalRequests;
    const avgLatencyMs = this.totalLatencyMs / this.totalRequests;
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    try {
      const message = JSON.stringify({
        wallet: this.wallet.address.toLowerCase(),
        tokensProcessed,
        avgLatencyMs,
        requestCount,
        uptimeSeconds,
        timestamp: Math.floor(Date.now() / 1000),
      });

      const signature = await this.wallet.signMessage(message);

      const payload: MetricsPayload = {
        wallet: this.wallet.address,
        tokensProcessed,
        avgLatencyMs,
        requestCount,
        uptimeSeconds,
        signature,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.oracleApiKey) {
        headers['x-api-key'] = this.oracleApiKey;
      }

      const response = await axios.post(
        `${this.oracleApiUrl}/api/v1/metrics/report`,
        payload,
        {
          headers,
          timeout: 5000,
        },
      );

      if (response.status === 200 || response.status === 201) {
        this.logger.log(
          `Metrics reported successfully: ${requestCount} requests, ` +
          `${tokensProcessed} tokens, ${avgLatencyMs.toFixed(2)}ms avg latency`,
        );

        this.totalTokens = 0;
        this.totalRequests = 0;
        this.totalLatencyMs = 0;
        this.logger.debug('Metrics counters reset after successful report');
      } else {
        this.logger.warn(
          `Unexpected response status ${response.status}, metrics not reset`,
        );
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          this.logger.warn(
            'Oracle API unreachable (ECONNREFUSED), will retry next interval. ' +
            `Current accumulated: ${requestCount} requests, ${tokensProcessed} tokens`,
          );
        } else if (error.response) {
          this.logger.error(
            `Failed to report metrics: HTTP ${error.response.status} - ${error.response.data?.message || error.message}. ` +
            `Metrics not reset, will retry next interval.`,
          );
        } else {
          this.logger.error(
            `Failed to report metrics: ${error.message}. Metrics not reset.`,
          );
        }
      } else if (error instanceof Error) {
        this.logger.error(
          `Signature generation or metrics report failed: ${error.message}. Skipping this cycle.`,
        );
      } else {
        this.logger.error('Unknown error during metrics reporting', error);
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
