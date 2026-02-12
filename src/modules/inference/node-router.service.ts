import { Injectable, Logger, ServiceUnavailableException, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';

export interface AgentGenerateRequest {
  inputs: string;
  parameters?: {
    max_new_tokens?: number;
    temperature?: number;
    top_p?: number;
    repetition_penalty?: number;
    do_sample?: boolean;
  };
}

export interface AgentGenerateResponse {
  generated_text: string;
  num_tokens?: number;
}

export interface PipelineNode {
  address: string;
  grpcEndpoint: string;
  httpEndpoint: string;
  layerStart: number;
  layerEnd: number;
  pipelineOrder: number;
  ready: boolean;
}

export interface PipelineTopology {
  model: string;
  totalLayers: number;
  nodes: PipelineNode[];
}

export interface NodeInfo {
  url: string;
  address: string;
  status: 'online' | 'offline';
  lastHealthCheck: number;
  consecutiveFailures: number;
}

@Injectable()
export class NodeRouterService implements OnModuleDestroy {
  private readonly logger = new Logger(NodeRouterService.name);
  private readonly oracleApiUrl: string | undefined;
  private readonly nodeUrls: string[];
  private readonly maxRetries = 3;
  private readonly healthCheckInterval = 30000;
  private readonly topologyRefreshInterval = 30000;
  private readonly maxConsecutiveFailures = 3;
  private readonly currentModel: string;

  private nodes: Map<string, NodeInfo> = new Map();
  private currentNodeIndex = 0;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private topologyRefreshTimer: NodeJS.Timeout | null = null;
  private topology: PipelineTopology | null = null;

  constructor() {
    this.oracleApiUrl = process.env.ORACLE_API_URL;
    this.currentModel = process.env.DEFAULT_MODEL || 'bigscience/bloom-560m';

    const nodeUrlsEnv = process.env.NODE_URLS || '';
    this.nodeUrls = nodeUrlsEnv
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    if (this.nodeUrls.length === 0 && !this.oracleApiUrl) {
      throw new Error(
        'Either ORACLE_API_URL or NODE_URLS must be configured',
      );
    }

    this.logger.log(
      `NodeRouter initialized with ${this.nodeUrls.length} static nodes` +
      (this.oracleApiUrl ? ` and Oracle discovery (${this.oracleApiUrl})` : ''),
    );

    this.initializeNodes();
    this.startHealthCheck();
    this.startTopologyRefresh();
  }

  private initializeNodes() {
    for (const url of this.nodeUrls) {
      this.nodes.set(url, {
        url,
        address: '',
        status: 'online',
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
      });
    }
  }

  private startHealthCheck() {
    this.healthCheckTimer = setInterval(async () => {
      await this.refreshNodesFromOracle();
      await this.checkNodesHealth();
    }, this.healthCheckInterval);
  }

  private startTopologyRefresh() {
    if (!this.oracleApiUrl) {
      this.logger.debug('Oracle API not configured, skipping topology refresh');
      return;
    }

    this.refreshTopology();
    this.topologyRefreshTimer = setInterval(async () => {
      await this.refreshTopology();
    }, this.topologyRefreshInterval);
  }

  private async refreshTopology() {
    if (!this.oracleApiUrl) return;

    try {
      const response = await axios.get<PipelineTopology>(
        `${this.oracleApiUrl}/api/v1/pipeline/topology`,
        {
          params: { model: this.currentModel },
          timeout: 5000,
        },
      );

      this.topology = response.data;
      this.logger.debug(
        `Topology refreshed: ${this.topology.nodes.length} nodes, ${this.topology.totalLayers} layers`,
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
        this.logger.debug('Oracle API unreachable for topology refresh');
      } else {
        this.logger.warn(`Failed to refresh topology: ${error.message}`);
      }
    }
  }

  private async refreshNodesFromOracle() {
    if (!this.oracleApiUrl) return;

    try {
      const response = await axios.get(`${this.oracleApiUrl}/api/nodes`, {
        timeout: 5000,
      });

      if (response.data?.nodes && Array.isArray(response.data.nodes)) {
        for (const node of response.data.nodes) {
          if (node.endpoint && node.endpoint.trim() && !this.nodes.has(node.endpoint)) {
            this.logger.log(`Discovered new node from Oracle: ${node.endpoint} (${node.address})`);
            this.nodes.set(node.endpoint, {
              url: node.endpoint,
              address: node.address || '',
              status: 'online',
              lastHealthCheck: Date.now(),
              consecutiveFailures: 0,
            });
          }
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
        this.logger.debug('Oracle API unreachable, using static nodes only');
      } else {
        this.logger.warn(`Failed to refresh nodes from Oracle: ${error.message}`);
      }
    }
  }

  private async checkNodesHealth() {
    const healthCheckPromises = Array.from(this.nodes.entries()).map(
      async ([url, node]) => {
        try {
          const client = axios.create({ baseURL: url, timeout: 5000 });
          await client.get('/health');

          node.status = 'online';
          node.consecutiveFailures = 0;
          node.lastHealthCheck = Date.now();
        } catch (error) {
          node.consecutiveFailures++;

          if (node.consecutiveFailures >= this.maxConsecutiveFailures) {
            if (node.status === 'online') {
              this.logger.warn(
                `Node ${url} marked as offline after ${this.maxConsecutiveFailures} failures`,
              );
            }
            node.status = 'offline';
          }

          node.lastHealthCheck = Date.now();
        }
      },
    );

    await Promise.all(healthCheckPromises);
  }

  private getFirstNode(): NodeInfo | null {
    if (!this.topology?.nodes?.length) return null;

    const firstNodes = this.topology.nodes
      .filter((n) => n.ready && n.pipelineOrder === 0)
      .sort((a, b) => a.pipelineOrder - b.pipelineOrder);

    if (firstNodes.length === 0) return null;

    const first = firstNodes[0];
    let nodeInfo = this.nodes.get(first.httpEndpoint);

    if (!nodeInfo) {
      nodeInfo = {
        url: first.httpEndpoint,
        address: first.address,
        status: 'online',
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
      };
      this.nodes.set(first.httpEndpoint, nodeInfo);
    }

    return nodeInfo;
  }

  private getNextNode(): NodeInfo | null {
    const onlineNodes = Array.from(this.nodes.values()).filter(
      (node) => node.status === 'online',
    );

    if (onlineNodes.length === 0) {
      return null;
    }

    const node = onlineNodes[this.currentNodeIndex % onlineNodes.length];
    this.currentNodeIndex++;

    return node;
  }

  async forwardRequest(
    request: AgentGenerateRequest,
  ): Promise<AgentGenerateResponse> {
    let lastError: Error | null = null;

    for (let retry = 0; retry < this.maxRetries; retry++) {
      const firstNode = this.getFirstNode();
      const node = firstNode || this.getNextNode();

      if (!node) {
        throw new ServiceUnavailableException(
          'No inference nodes available. Please try again later.',
        );
      }

      if (firstNode) {
        this.logger.debug(`Routing to pipeline first node: ${node.url}`);
      }

      try {
        const client = axios.create({
          baseURL: node.url,
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' },
        });

        const response = await client.post<AgentGenerateResponse>(
          '/api/v1/generate',
          request,
        );

        node.consecutiveFailures = 0;

        return response.data;
      } catch (error) {
        lastError = error as Error;
        node.consecutiveFailures++;

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
            this.logger.warn(
              `Node ${node.url} unreachable, trying next node (retry ${retry + 1}/${this.maxRetries})`,
            );
            node.status = 'offline';
            continue;
          }

          if (error.response?.status && error.response.status >= 500) {
            this.logger.warn(
              `Node ${node.url} returned server error ${error.response.status}, trying next node`,
            );
            continue;
          }

          if (error.response) {
            throw new ServiceUnavailableException(
              `Inference failed: ${error.response.data?.error || 'Unknown error'}`,
            );
          }
        }

        throw error;
      }
    }

    this.logger.error('All retry attempts exhausted', lastError);
    throw new ServiceUnavailableException(
      'All inference nodes failed. Please try again later.',
    );
  }

  async *forwardStreamRequest(
    request: AgentGenerateRequest,
  ): AsyncGenerator<string> {
    let lastError: Error | null = null;

    for (let retry = 0; retry < this.maxRetries; retry++) {
      const firstNode = this.getFirstNode();
      const node = firstNode || this.getNextNode();

      if (!node) {
        throw new ServiceUnavailableException(
          'No inference nodes available. Please try again later.',
        );
      }

      if (firstNode) {
        this.logger.debug(`Routing stream to pipeline first node: ${node.url}`);
      }

      try {
        const client = axios.create({
          baseURL: node.url,
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' },
        });

        const response = await client.post<any>(
          '/api/v1/generate',
          { ...request, stream: true },
          { responseType: 'stream' },
        );

        node.consecutiveFailures = 0;

        for await (const chunk of response.data) {
          const text = chunk.toString('utf-8');
          const lines = text.split('\n').filter((line: string) => line.trim());

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                return;
              }
              yield data;
            }
          }
        }

        return;
      } catch (error) {
        lastError = error as Error;
        node.consecutiveFailures++;

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
            this.logger.warn(
              `Node ${node.url} unreachable during stream, trying next node (retry ${retry + 1}/${this.maxRetries})`,
            );
            node.status = 'offline';
            continue;
          }
        }

        throw error;
      }
    }

    this.logger.error('All stream retry attempts exhausted', lastError);
    throw new ServiceUnavailableException(
      'All inference nodes failed for streaming. Please try again later.',
    );
  }

  getActiveNodes(): NodeInfo[] {
    return Array.from(this.nodes.values()).filter(
      (node) => node.status === 'online',
    );
  }

  getAllNodes(): NodeInfo[] {
    return Array.from(this.nodes.values());
  }

  getNodeStats(address: string): NodeInfo | undefined {
    return Array.from(this.nodes.values()).find(
      (node) => node.address.toLowerCase() === address.toLowerCase(),
    );
  }

  getTopology(): PipelineTopology | null {
    return this.topology;
  }

  onModuleDestroy() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    if (this.topologyRefreshTimer) {
      clearInterval(this.topologyRefreshTimer);
    }
  }
}
