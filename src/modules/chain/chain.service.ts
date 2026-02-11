import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { CHAIN_CONFIG } from './chain.config';
import InferencePaymentABI from '../../common/abis/InferencePayment.json';

@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger(ChainService.name);
  private provider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider;
  private signer?: ethers.Wallet;

  private agentRegistryContract?: ethers.Contract;
  private rewardPoolContract?: ethers.Contract;
  private inferencePaymentContract?: ethers.Contract;

  async onModuleInit() {
    this.provider = new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrl);
    this.wsProvider = new ethers.WebSocketProvider(CHAIN_CONFIG.wsUrl);

    if (CHAIN_CONFIG.gatewayPrivateKey) {
      this.signer = new ethers.Wallet(CHAIN_CONFIG.gatewayPrivateKey, this.provider);
      this.logger.log(`Gateway signer initialized: ${this.signer.address}`);
    } else {
      this.logger.warn('Gateway private key not configured, credit deduction will fail');
    }

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

  getInferencePaymentContract(): ethers.Contract | null {
    const address = CHAIN_CONFIG.contracts.inferencePayment;
    if (!address) {
      return null;
    }
    const signerOrProvider = this.signer || this.provider;
    return new ethers.Contract(address, InferencePaymentABI, signerOrProvider);
  }

  getSigner(): ethers.Wallet | null {
    return this.signer || null;
  }
}
