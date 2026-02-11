import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  getContract,
  verifyMessage,
  type PublicClient,
  type WalletClient,
  type GetContractReturnType,
  type Address,
  type Chain,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  plumise,
  addresses,
  inferencePaymentAbi,
  formatPLM,
} from '@plumise/core';
import { CHAIN_CONFIG } from './chain.config';

@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger(ChainService.name);
  private publicClient: PublicClient;
  private wsPublicClient: PublicClient;
  private walletClient: WalletClient | null = null;
  private signerAddress: Address | null = null;

  async onModuleInit() {
    const chain: Chain = {
      ...plumise,
      id: CHAIN_CONFIG.chainId,
    };

    this.publicClient = createPublicClient({
      chain,
      transport: http(CHAIN_CONFIG.rpcUrl),
    });

    this.wsPublicClient = createPublicClient({
      chain,
      transport: webSocket(CHAIN_CONFIG.wsUrl),
    });

    if (CHAIN_CONFIG.gatewayPrivateKey) {
      const account = privateKeyToAccount(CHAIN_CONFIG.gatewayPrivateKey as `0x${string}`);
      this.signerAddress = account.address;
      this.walletClient = createWalletClient({
        account,
        chain,
        transport: http(CHAIN_CONFIG.rpcUrl),
      });
      this.logger.log(`Gateway signer initialized: ${account.address}`);
    } else {
      this.logger.warn('Gateway private key not configured, credit deduction will fail');
    }

    const chainId = await this.publicClient.getChainId();
    this.logger.log(`Connected to chain: ${chainId}`);

    this.setupContracts();
  }

  private setupContracts() {
    this.logger.log('Contract addresses:', CHAIN_CONFIG.contracts);
  }

  getPublicClient(): PublicClient {
    return this.publicClient;
  }

  getWsPublicClient(): PublicClient {
    return this.wsPublicClient;
  }

  async getBalance(address: string): Promise<bigint> {
    return await this.publicClient.getBalance({ address: address as Address });
  }

  async getBlockNumber(): Promise<number> {
    const blockNumber = await this.publicClient.getBlockNumber();
    return Number(blockNumber);
  }

  async verifySignature(
    message: string,
    signature: string,
    expectedAddress: string,
  ): Promise<boolean> {
    try {
      const valid = await verifyMessage({
        address: expectedAddress as Address,
        message,
        signature: signature as `0x${string}`,
      });
      return valid;
    } catch (error) {
      this.logger.error('Signature verification failed:', error);
      return false;
    }
  }

  getInferencePaymentContract() {
    const address = CHAIN_CONFIG.contracts.inferencePayment || addresses.mainnet.InferencePayment;
    if (!address || address === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    const client = this.walletClient
      ? { public: this.publicClient, wallet: this.walletClient }
      : this.publicClient;

    return getContract({
      address: address as Address,
      abi: inferencePaymentAbi,
      client,
    });
  }

  getSignerAddress(): Address | null {
    return this.signerAddress;
  }

  getWalletClient(): WalletClient | null {
    return this.walletClient;
  }
}
