import { Injectable, Inject, Logger, ServiceUnavailableException, OnModuleDestroy, Optional } from '@nestjs/common';
import axios from 'axios';
import { AgentRelayService } from './agent-relay.service';
import { stripChannelTokens } from '../../common/utils';

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
  nodeType: 'openai' | 'pipeline' | 'ws-relay' | 'unknown';
}

@Injectable()
export class NodeRouterService implements OnModuleDestroy {
  private readonly logger = new Logger(NodeRouterService.name);
  private readonly oracleApiUrl: string | undefined;
  private readonly nodeUrls: string[];
  private readonly healthCheckInterval = 30000;
  private readonly topologyRefreshInterval = 30000;
  private readonly maxConsecutiveFailures = 3;
  private readonly currentModel: string;
  private readonly allowPrivateIps: boolean;

  private nodes: Map<string, NodeInfo> = new Map();
  private currentNodeIndex = 0;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private topologyRefreshTimer: NodeJS.Timeout | null = null;
  private topology: PipelineTopology | null = null;

  constructor(
    @Optional() @Inject(AgentRelayService) private readonly agentRelay: AgentRelayService | null,
  ) {
    this.oracleApiUrl = process.env.ORACLE_API_URL;
    this.currentModel = process.env.DEFAULT_MODEL || 'bigscience/bloom-560m';
    this.allowPrivateIps = process.env.ALLOW_PRIVATE_IPS !== 'false';

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
      (this.oracleApiUrl ? ` and Oracle discovery (${this.oracleApiUrl})` : '') +
      (this.allowPrivateIps ? ' (private IPs allowed)' : ''),
    );

    this.initializeNodes();
    this.startHealthCheck();
    this.startTopologyRefresh();
  }

  private isValidNodeUrl(url: string): boolean {
    try {
      const parsed = new URL(url);

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        this.logger.warn(`Invalid protocol for node URL: ${url}`);
        return false;
      }

      const hostname = parsed.hostname.toLowerCase();

      // Always reject localhost/loopback
      const localHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '::'];
      if (localHosts.includes(hostname)) {
        this.logger.warn(`Local hostname rejected for node URL: ${url}`);
        return false;
      }

      // Skip private IP checks if allowed
      if (this.allowPrivateIps) return true;

      const ipParts = hostname.split('.');
      if (ipParts.length === 4 && ipParts.every(p => /^\d+$/.test(p))) {
        const octets = ipParts.map(p => parseInt(p, 10));

        if (octets[0] === 10 ||
          (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
          (octets[0] === 192 && octets[1] === 168) ||
          (octets[0] === 169 && octets[1] === 254)) {
          this.logger.warn(`Private IP rejected: ${url}`);
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.warn(`Failed to parse node URL: ${url}`);
      return false;
    }
  }

  private initializeNodes() {
    for (const url of this.nodeUrls) {
      this.nodes.set(url, {
        url,
        address: '',
        status: 'online',
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
        nodeType: 'unknown',
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

    // Initial refresh + immediate health check to detect node types before first request
    this.refreshTopology().then(() => this.checkNodesHealth());
    this.topologyRefreshTimer = setInterval(async () => {
      await this.refreshTopology();
    }, this.topologyRefreshInterval);
  }

  private async refreshTopology() {
    if (!this.oracleApiUrl) return;

    try {
      const response = await axios.get(
        `${this.oracleApiUrl}/api/v1/pipeline/topology`,
        {
          params: { model: this.currentModel },
          timeout: 5000,
        },
      );

      const data = response.data;
      const nodes: PipelineNode[] = (data.nodes || []).map((n: any) => ({
        address: n.nodeAddress || n.address || '',
        grpcEndpoint: n.grpcEndpoint || '',
        httpEndpoint: n.httpEndpoint || '',
        layerStart: n.layerStart,
        layerEnd: n.layerEnd,
        pipelineOrder: n.pipelineOrder,
        ready: n.ready,
      }));

      const totalLayers = nodes.length > 0
        ? Math.max(...nodes.map((n) => n.layerEnd))
        : 0;

      this.topology = {
        model: data.model || this.currentModel,
        totalLayers,
        nodes,
      };

      // Register all topology nodes into the nodes map
      let hasNewNodes = false;
      for (const pNode of nodes) {
        if (!pNode.ready || !pNode.httpEndpoint) continue;
        if (!this.isValidNodeUrl(pNode.httpEndpoint)) continue;
        if (!this.nodes.has(pNode.httpEndpoint)) {
          this.logger.log(`Discovered topology node: ${pNode.httpEndpoint} (${pNode.address})`);
          this.nodes.set(pNode.httpEndpoint, {
            url: pNode.httpEndpoint,
            address: pNode.address,
            status: 'online',
            lastHealthCheck: 0,
            consecutiveFailures: 0,
            nodeType: 'unknown',
          });
          hasNewNodes = true;
        }
      }

      // Immediately detect node type for newly discovered nodes
      if (hasNewNodes) {
        this.checkNodesHealth().catch(() => {});
      }

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
            if (!this.isValidNodeUrl(node.endpoint)) continue;

            this.logger.log(`Discovered new node from Oracle: ${node.endpoint} (${node.address})`);
            this.nodes.set(node.endpoint, {
              url: node.endpoint,
              address: node.address || '',
              status: 'online',
              lastHealthCheck: Date.now(),
              consecutiveFailures: 0,
              nodeType: 'unknown',
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
          const resp = await axios.get(`${url}/health`, { timeout: 5000 });

          node.status = 'online';
          node.consecutiveFailures = 0;
          node.lastHealthCheck = Date.now();

          // Detect node type from health response
          if (resp.data?.mode === 'pipeline') {
            node.nodeType = 'pipeline';
          } else if (node.nodeType === 'unknown') {
            // llama-server returns {"status":"ok"} without mode field
            node.nodeType = 'openai';
          }
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

  /**
   * Get candidate nodes sorted by priority:
   * 1. OpenAI-compatible nodes (standalone llama-server) — can handle full model
   * 2. Pipeline first node (pipelineOrder=0)
   * 3. Other nodes as fallback
   * Only returns online nodes.
   */
  private getCandidateNodes(): NodeInfo[] {
    const candidates: { node: NodeInfo; priority: number }[] = [];
    const seen = new Set<string>();

    // Add WebSocket-connected agents (highest priority — directly reachable)
    if (this.agentRelay?.hasConnectedAgents()) {
      for (const agent of this.agentRelay.getConnectedAgents()) {
        const key = `ws-relay://${agent.address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          node: {
            url: key,
            address: agent.address,
            status: 'online',
            lastHealthCheck: Date.now(),
            consecutiveFailures: 0,
            nodeType: 'ws-relay',
          },
          priority: -1, // Highest priority
        });
      }
    }

    // Add topology nodes with priority
    if (this.topology?.nodes?.length) {
      for (const pNode of this.topology.nodes) {
        if (!pNode.ready || !pNode.httpEndpoint) continue;

        const nodeInfo = this.nodes.get(pNode.httpEndpoint);
        if (!nodeInfo || nodeInfo.status === 'offline') continue;
        if (seen.has(nodeInfo.url)) continue;
        seen.add(nodeInfo.url);

        let priority: number;
        if (nodeInfo.nodeType === 'openai') {
          priority = 0; // Highest — standalone, can handle full inference
        } else if (nodeInfo.nodeType === 'unknown') {
          priority = 1; // Unknown — likely OpenAI-compatible, try before pipeline
        } else if (pNode.pipelineOrder === 0 && nodeInfo.nodeType === 'pipeline') {
          priority = 5; // Pipeline entry point — slow, requires inter-node coordination
        } else {
          priority = 10 + pNode.pipelineOrder; // Pipeline non-first nodes (can't serve alone)
        }

        candidates.push({ node: nodeInfo, priority });
      }
    }

    // Add static/discovered nodes not in topology
    for (const nodeInfo of this.nodes.values()) {
      if (nodeInfo.status === 'offline') continue;
      if (seen.has(nodeInfo.url)) continue;
      seen.add(nodeInfo.url);
      candidates.push({ node: nodeInfo, priority: 20 });
    }

    return candidates.sort((a, b) => a.priority - b.priority).map(c => c.node);
  }

  private async tryOpenAIRequest(
    client: ReturnType<typeof axios.create>,
    request: AgentGenerateRequest,
  ): Promise<AgentGenerateResponse> {
    const resp = await client.post('/v1/chat/completions', {
      model: this.currentModel,
      messages: [{ role: 'user', content: request.inputs }],
      max_tokens: request.parameters?.max_new_tokens || 512,
      temperature: request.parameters?.temperature || 0.7,
      top_p: request.parameters?.top_p || 0.9,
    });
    return {
      generated_text: stripChannelTokens(resp.data?.choices?.[0]?.message?.content || ''),
      num_tokens: resp.data?.usage?.completion_tokens,
    };
  }

  private async tryPipelineRequest(
    client: ReturnType<typeof axios.create>,
    request: AgentGenerateRequest,
  ): Promise<AgentGenerateResponse> {
    const resp = await client.post<AgentGenerateResponse>('/api/v1/generate', request);
    return resp.data;
  }

  async forwardRequest(
    request: AgentGenerateRequest,
  ): Promise<AgentGenerateResponse> {
    const candidates = this.getCandidateNodes();

    if (candidates.length === 0) {
      throw new ServiceUnavailableException(
        'No inference nodes available. Please try again later.',
      );
    }

    let lastError: Error | null = null;

    for (const node of candidates) {
      // WebSocket relay — forward through connected agent
      if (node.nodeType === 'ws-relay' && this.agentRelay) {
        try {
          this.logger.debug(`Routing to WS-relay agent: ${node.address}`);
          const result = await this.agentRelay.sendRequest(node.address, request);
          return result;
        } catch (error) {
          lastError = error as Error;
          this.logger.warn(`WS-relay request failed: ${lastError.message}, trying next`);
          continue;
        }
      }

      // CPU-based pipeline inference can take 30s+ for long prompts (prefill phase)
      const timeout = 120000;
      const client = axios.create({
        baseURL: node.url,
        timeout,
        headers: { 'Content-Type': 'application/json' },
      });

      try {
        let result: AgentGenerateResponse;

        if (node.nodeType === 'pipeline') {
          this.logger.debug(`Routing to pipeline node: ${node.url}`);
          result = await this.tryPipelineRequest(client, request);
        } else {
          // OpenAI or unknown — try OpenAI format first
          this.logger.debug(`Routing to OpenAI-compatible node: ${node.url}`);
          try {
            result = await this.tryOpenAIRequest(client, request);
            node.nodeType = 'openai';
          } catch (openaiError) {
            // If 404, this node doesn't support OpenAI — try pipeline format
            if (axios.isAxiosError(openaiError) && openaiError.response?.status === 404) {
              this.logger.debug(`Node ${node.url} doesn't support OpenAI format, trying pipeline`);
              node.nodeType = 'pipeline';
              result = await this.tryPipelineRequest(client, request);
            } else {
              throw openaiError;
            }
          }
        }

        node.consecutiveFailures = 0;
        return result;
      } catch (error) {
        lastError = error as Error;
        node.consecutiveFailures++;

        if (axios.isAxiosError(error)) {
          const respBody = error.response?.data;
          if (respBody) {
            this.logger.warn(`Node ${node.url} HTTP ${error.response?.status} body: ${JSON.stringify(respBody).slice(0, 500)}`);
          }

          if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
            this.logger.warn(`Node ${node.url} unreachable, trying next node`);
            node.status = 'offline';
            continue;
          }

          if (error.response?.status && error.response.status >= 500) {
            this.logger.warn(`Node ${node.url} server error ${error.response.status}, trying next`);
            continue;
          }
        }

        this.logger.warn(`Node ${node.url} failed: ${lastError.message}, trying next`);
        continue;
      }
    }

    this.logger.error('All nodes exhausted', lastError);
    throw new ServiceUnavailableException(
      'All inference nodes failed. Please try again later.',
    );
  }

  async *forwardStreamRequest(
    request: AgentGenerateRequest,
  ): AsyncGenerator<string> {
    const candidates = this.getCandidateNodes();

    if (candidates.length === 0) {
      throw new ServiceUnavailableException(
        'No inference nodes available. Please try again later.',
      );
    }

    let lastError: Error | null = null;

    for (const node of candidates) {
      // WebSocket relay — stream through connected agent
      if (node.nodeType === 'ws-relay' && this.agentRelay) {
        try {
          this.logger.debug(`Streaming from WS-relay agent: ${node.address}`);
          for await (const chunk of this.agentRelay.sendStreamRequest(node.address, request)) {
            yield chunk;
          }
          return;
        } catch (error) {
          lastError = error as Error;
          this.logger.warn(`WS-relay stream failed: ${lastError.message}, trying next`);
          continue;
        }
      }

      const streamTimeout = 120000;
      const client = axios.create({
        baseURL: node.url,
        timeout: streamTimeout,
        headers: { 'Content-Type': 'application/json' },
      });

      try {
        if (node.nodeType === 'openai' || node.nodeType === 'unknown') {
          // Try OpenAI streaming format
          this.logger.debug(`Streaming from OpenAI-compatible node: ${node.url}`);
          const response = await client.post(
            '/v1/chat/completions',
            {
              model: this.currentModel,
              messages: [{ role: 'user', content: request.inputs }],
              max_tokens: request.parameters?.max_new_tokens || 512,
              temperature: request.parameters?.temperature || 0.7,
              top_p: request.parameters?.top_p || 0.9,
              stream: true,
            },
            { responseType: 'stream' },
          );

          node.consecutiveFailures = 0;
          node.nodeType = 'openai';

          for await (const chunk of response.data) {
            const text = chunk.toString('utf-8');
            const lines = text.split('\n').filter((line: string) => line.trim());

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') return;
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    yield content;
                  }
                } catch {
                  // skip unparseable chunks
                }
              }
            }
          }

          return;
        } else {
          // Pipeline format
          this.logger.debug(`Streaming from pipeline node: ${node.url}`);
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
                if (data === '[DONE]') return;
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.token) {
                    yield parsed.token;
                  } else if (parsed.error) {
                    throw new Error(parsed.error);
                  }
                } catch (parseErr) {
                  // If not JSON, yield raw data
                  yield data;
                }
              }
            }
          }

          return;
        }
      } catch (error) {
        lastError = error as Error;
        node.consecutiveFailures++;

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
            this.logger.warn(`Node ${node.url} unreachable during stream, trying next`);
            node.status = 'offline';
            continue;
          }

          // If OpenAI 404 on unknown node, mark as pipeline and retry
          if (error.response?.status === 404 && node.nodeType === 'unknown') {
            node.nodeType = 'pipeline';
            try {
              this.logger.debug(`Retrying stream as pipeline format: ${node.url}`);
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
                    if (data === '[DONE]') return;
                    yield data;
                  }
                }
              }
              return;
            } catch {
              continue;
            }
          }
        }

        this.logger.warn(`Node ${node.url} stream failed: ${lastError.message}, trying next`);
        continue;
      }
    }

    this.logger.error('All stream nodes exhausted', lastError);
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
