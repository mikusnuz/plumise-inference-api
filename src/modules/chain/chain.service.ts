import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { CHAIN_CONFIG } from './chain.config';

@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger(ChainService.name);
  private provider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider;

  private agentRegistryContract?: ethers.Contract;
  private rewardPoolContract?: ethers.Contract;
  private inferencePaymentContract?: ethers.Contract;

  async onModuleInit() {
    this.provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
    this.wsProvider = new ethers.WebSocketProvider(CHAIN_CONFIG.wsUrl);

    const network = await this.provider.getNetwork();
    this.logger.log(`Connected to chain: ${network.name} (${network.chainId})`);

    this.setupContracts();
  }

  private setupContracts() {
    // Contract setup will be done after deployment
    // For now, we just log the addresses
    this.logger.log('Contract addresses:', CHAIN_CONFIG.contracts);
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  getWsProvider(): ethers.WebSocketProvider {
    return this.wsProvider;
  }

  async getBalance(address: string): Promise<bigint> {
    return await this.provider.getBalance(address);
  }

  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  async verifySignature(
    message: string,
    signature: string,
    expectedAddress: string,
  ): Promise<boolean> {
    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    } catch (error) {
      this.logger.error('Signature verification failed:', error);
      return false;
    }
  }
}
