export const CHAIN_CONFIG = {
  chainId: parseInt(process.env.CHAIN_ID || '41956'),
  rpcUrl: process.env.CHAIN_RPC_URL || 'http://localhost:26902',
  wsUrl: process.env.CHAIN_WS_URL || 'ws://localhost:26912',
  contracts: {
    agentRegistry: process.env.AGENT_REGISTRY_ADDRESS || '',
    rewardPool: process.env.REWARD_POOL_ADDRESS || '0x1000',
    inferencePayment: process.env.INFERENCE_PAYMENT_ADDRESS || '',
  },
};
