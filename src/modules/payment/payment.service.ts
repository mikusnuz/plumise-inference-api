import { Injectable, Logger } from '@nestjs/common';
import { ChainService } from '../chain/chain.service';
import { ethers } from 'ethers';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly chainService: ChainService) {}

  async getUserTier(address: string): Promise<'free' | 'pro'> {
    try {
      const contract = this.chainService.getInferencePaymentContract();
      if (!contract) {
        this.logger.debug('InferencePayment contract not configured, defaulting to free tier');
        return 'free';
      }

      const tier = await contract.getUserTier(address);
      return tier === 1n ? 'pro' : 'free';
    } catch (error) {
      this.logger.error(`Failed to get user tier for ${address}: ${error.message}`);
      return 'free';
    }
  }

  async getCredits(address: string): Promise<number> {
    try {
      const contract = this.chainService.getInferencePaymentContract();
      if (!contract) {
        this.logger.debug('InferencePayment contract not configured');
        return 0;
      }

      const balance = await contract.getUserBalance(address);
      return parseFloat(ethers.formatEther(balance));
    } catch (error) {
      this.logger.error(`Failed to get credits for ${address}: ${error.message}`);
      return 0;
    }
  }

  async deductCredits(address: string, tokens: number): Promise<boolean> {
    try {
      const contract = this.chainService.getInferencePaymentContract();
      if (!contract) {
        this.logger.debug('InferencePayment contract not configured, skipping deduction');
        return true;
      }

      const signer = this.chainService.getSigner();
      if (!signer) {
        this.logger.warn('Gateway signer not configured, skipping deduction');
        return true;
      }

      const tier = await this.getUserTier(address);
      if (tier !== 'pro') {
        this.logger.debug(`User ${address} is free tier, skipping deduction`);
        return true;
      }

      this.logger.log(`Deducting ${tokens} tokens for ${address}`);
      const tx = await contract.useCredits(address, tokens);
      await tx.wait();

      this.logger.log(`Successfully deducted ${tokens} tokens for ${address}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to deduct credits for ${address}: ${error.message}`);
      return false;
    }
  }
}
