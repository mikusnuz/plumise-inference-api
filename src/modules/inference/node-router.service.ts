import { Injectable, Inject, Logger, ServiceUnavailableException, OnModuleDestroy, Optional } from '@nestjs/common';
import axios from 'axios';
import { AgentRelayService } from './agent-relay.service';
import { stripChannelTokens } from '../../common/utils';

export interface AgentGenerateRequest {
  inputs: string;
  messages?: { role: string; content: string }[];
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
  agent_address?: string;
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
  capacityScore: number; // benchmark tok/s or default 1.0
  cooldownUntil: number; // timestamp — excluded from candidates until this time
}

/**
 * Tracks in-flight requests per node to avoid overloading busy nodes.
 * Used in weighted random selection: weight = capacity / (1 + inFlight)
 */
class InFlightTracker {
  private counts = new Map<string, number>();

  acquire(key: string): void {
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
  }

  release(key: string): void {
    const count = this.counts.get(key) || 0;
    this.counts.set(key, Math.max(0, count - 1));
  }

  getCount(key: string): number {
    return this.counts.get(key) || 0;
  }
}

@Injectable()
export class NodeRouterService implements OnModuleDestroy {
  private readonly logger = new Logger(NodeRouterService.name);
  private readonly oracleApiUrl: string | undefined;
  private readonly nodeUrls: string[];
  private readonly healthCheckInterval = 30000;
  private readonly topologyRefreshInterval = 30000;
  private readonly maxConsecutiveFailures = 3;
  private readonly cooldownDuration = 30000; // 30s cooldown after consecutive failures
  private readonly currentModel: string;
  private readonly allowPrivateIps: boolean;

  private nodes: Map<string, NodeInfo> = new Map();
  private inFlight = new InFlightTracker();
  public lastStreamAgentAddress: string | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private topologyRefreshTimer: NodeJS.Timeout | null = null;
  private topology: PipelineTopology | null = null;
  private capacityCache: Map<string, number> = new Map(); // address → benchmarkTokPerSec

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
      if (!this.isValidNodeUrl(url)) {
        this.logger.warn(`Skipping invalid static node URL: ${url}`);
        continue;
      }
      this.nodes.set(url, {
        url,
        address: '',
        status: 'online',
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
        nodeType: 'unknown',
        capacityScore: 1.0,
        cooldownUntil: 0,
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

      // Cache benchmark data from topology nodes
      for (const raw of (data.nodes || [])) {
        const addr = (raw.nodeAddress || raw.address || '').toLowerCase();
        const benchmark = raw.benchmarkTokPerSec;
        if (addr && benchmark > 0) {
          this.capacityCache.set(addr, benchmark);
        }
      }

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
            status: 'offline', // Start offline; health check will promote to online
            lastHealthCheck: 0,
            consecutiveFailures: 0,
            nodeType: 'unknown',
            capacityScore: 1.0,
            cooldownUntil: 0,
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
              status: 'offline', // Start offline; health check will promote to online
              lastHealthCheck: 0,
              consecutiveFailures: 0,
              nodeType: 'unknown',
              capacityScore: 1.0,
              cooldownUntil: 0,
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

    // Fetch capacity data to update node scores
    try {
      const capacityResponse = await axios.get(`${this.oracleApiUrl}/api/v1/metrics/capacity`, {
        timeout: 5000,
      });

      if (Array.isArray(capacityResponse.data)) {
        for (const cap of capacityResponse.data) {
          const addr = (cap.address || '').toLowerCase();
          if (!addr) continue;

          // Update capacity cache
          if (cap.benchmarkTokPerSec > 0) {
            this.capacityCache.set(addr, cap.benchmarkTokPerSec);

            // Find node by address and update capacity score
            for (const nodeInfo of this.nodes.values()) {
              if (nodeInfo.address.toLowerCase() === addr) {
                nodeInfo.capacityScore = cap.benchmarkTokPerSec;
                break;
              }
            }
          }
        }
      }
    } catch (error) {
      // Non-critical: capacity data enhances routing but isn't required
      this.logger.debug(`Failed to fetch capacity data: ${error instanceof Error ? error.message : 'Unknown'}`);
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
   * Get all candidate nodes as a flat pool.
   * Filters out offline nodes and nodes in cooldown.
   * No priority sorting — weighted random selection handles distribution.
   */
  private getCandidateNodes(): NodeInfo[] {
    const candidates: NodeInfo[] = [];
    const seen = new Set<string>();
    const seenAddresses = new Set<string>(); // Deduplicate by address (WS relay vs HTTP)
    const now = Date.now();

    // Add WebSocket-connected agents (preferred over HTTP for same node)
    if (this.agentRelay?.hasConnectedAgents()) {
      for (const agent of this.agentRelay.getConnectedAgents()) {
        const key = `ws-relay://${agent.address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seenAddresses.add(agent.address.toLowerCase());
        candidates.push({
          url: key,
          address: agent.address,
          status: 'online',
          lastHealthCheck: now,
          consecutiveFailures: 0,
          nodeType: 'ws-relay',
          capacityScore: this.capacityCache.get(agent.address.toLowerCase()) || 1.0,
          cooldownUntil: 0,
        });
      }
    }

    // Add topology nodes (skip if already added via WS relay)
    if (this.topology?.nodes?.length) {
      for (const pNode of this.topology.nodes) {
        if (!pNode.ready || !pNode.httpEndpoint) continue;
        if (seenAddresses.has(pNode.address.toLowerCase())) continue;

        const nodeInfo = this.nodes.get(pNode.httpEndpoint);
        if (!nodeInfo || nodeInfo.status === 'offline') continue;
        if (nodeInfo.cooldownUntil > now) continue;
        if (seen.has(nodeInfo.url)) continue;
        seen.add(nodeInfo.url);
        seenAddresses.add(pNode.address.toLowerCase());

        // Skip pipeline non-entry nodes (can't serve alone)
        if (nodeInfo.nodeType === 'pipeline' && pNode.pipelineOrder !== 0) continue;

        candidates.push(nodeInfo);
      }
    }

    // Add static/discovered nodes not in topology (skip if address already seen)
    for (const nodeInfo of this.nodes.values()) {
      if (nodeInfo.status === 'offline') continue;
      if (nodeInfo.cooldownUntil > now) continue;
      if (nodeInfo.address && seenAddresses.has(nodeInfo.address.toLowerCase())) continue;
      if (seen.has(nodeInfo.url)) continue;
      seen.add(nodeInfo.url);
      candidates.push(nodeInfo);
    }

    return candidates;
  }

  /**
   * Weighted random selection from candidate pool.
   * Weight = capacityScore / (1 + inFlightRequests), minimum 0.1
   * Excludes nodes in the `excluded` set (for retry after failure).
   */
  private selectNode(candidates: NodeInfo[], excluded: Set<string> = new Set()): NodeInfo | null {
    const available = candidates.filter(c => !excluded.has(c.url));
    if (available.length === 0) return null;
    if (available.length === 1) return available[0];

    const MIN_WEIGHT = 0.1;
    const weights = available.map(c => {
      const base = c.capacityScore || 1.0;
      const load = this.inFlight.getCount(c.url);
      return Math.max(base / (1 + load), MIN_WEIGHT);
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    for (let i = 0; i < available.length; i++) {
      random -= weights[i];
      if (random <= 0) return available[i];
    }
    return available[available.length - 1];
  }

  /**
   * Mark a node as failed. After maxConsecutiveFailures, apply cooldown.
   */
  private markNodeFailed(node: NodeInfo): void {
    node.consecutiveFailures++;
    if (node.consecutiveFailures >= this.maxConsecutiveFailures) {
      node.cooldownUntil = Date.now() + this.cooldownDuration;
      this.logger.warn(
        `Node ${node.url} in cooldown for ${this.cooldownDuration / 1000}s after ${node.consecutiveFailures} failures`,
      );
    }
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
    const excluded = new Set<string>();
    const maxRetries = Math.min(candidates.length, 5);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const node = this.selectNode(candidates, excluded);
      if (!node) break;

      excluded.add(node.url);
      this.inFlight.acquire(node.url);

      try {
        // WebSocket relay — forward through connected agent
        if (node.nodeType === 'ws-relay' && this.agentRelay) {
          this.logger.debug(`[attempt ${attempt + 1}/${maxRetries}] Routing to WS-relay agent: ${node.address}`);
          const result = await this.agentRelay.sendRequest(node.address, request);
          result.agent_address = node.address;
          node.consecutiveFailures = 0;
          return result;
        }

        // HTTP node
        const timeout = 120000;
        const client = axios.create({
          baseURL: node.url,
          timeout,
          headers: { 'Content-Type': 'application/json' },
        });

        let result: AgentGenerateResponse;

        if (node.nodeType === 'pipeline') {
          this.logger.debug(`[attempt ${attempt + 1}/${maxRetries}] Routing to pipeline node: ${node.url}`);
          result = await this.tryPipelineRequest(client, request);
        } else {
          this.logger.debug(`[attempt ${attempt + 1}/${maxRetries}] Routing to OpenAI-compatible node: ${node.url}`);
          try {
            result = await this.tryOpenAIRequest(client, request);
            node.nodeType = 'openai';
          } catch (openaiError) {
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
        result.agent_address = node.address;
        return result;
      } catch (error) {
        lastError = error as Error;
        this.markNodeFailed(node);

        if (axios.isAxiosError(error)) {
          const respBody = error.response?.data;
          if (respBody) {
            this.logger.warn(`Node ${node.url} HTTP ${error.response?.status} body: ${JSON.stringify(respBody).slice(0, 500)}`);
          }
          if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
            node.status = 'offline';
          }
        }

        this.logger.warn(`[attempt ${attempt + 1}/${maxRetries}] Node ${node.url} failed: ${lastError.message}, re-selecting`);
      } finally {
        this.inFlight.release(node.url);
      }
    }

    this.logger.error('All nodes exhausted', lastError);
    throw new ServiceUnavailableException(
      'All inference nodes failed. Please try again later.',
    );
  }

  /**
   * Build a continuation request that includes already-generated tokens.
   * The new node receives the partial response as context and continues from there.
   */
  private buildContinuationRequest(
    original: AgentGenerateRequest,
    accumulatedTokens: string,
  ): AgentGenerateRequest {
    // For messages-based requests, append partial assistant response
    if (original.messages?.length) {
      return {
        ...original,
        messages: [
          ...original.messages,
          { role: 'assistant', content: accumulatedTokens },
          { role: 'user', content: 'Continue generating from exactly where you left off. Do not repeat any text.' },
        ],
      };
    }

    // For inputs-based requests, embed the partial output in the prompt
    return {
      ...original,
      inputs: `${original.inputs}\n\nAssistant (partial, continue from here): ${accumulatedTokens}`,
    };
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
    const excluded = new Set<string>();
    const maxRetries = Math.min(candidates.length, 5);
    let accumulatedTokens = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const node = this.selectNode(candidates, excluded);
      if (!node) break;

      excluded.add(node.url);
      this.inFlight.acquire(node.url);

      // Use continuation request if we have partial output from a previous failed attempt
      const effectiveRequest = accumulatedTokens
        ? this.buildContinuationRequest(request, accumulatedTokens)
        : request;

      try {
        // WebSocket relay — stream through connected agent
        if (node.nodeType === 'ws-relay' && this.agentRelay) {
          this.logger.debug(`[attempt ${attempt + 1}/${maxRetries}] Streaming from WS-relay agent: ${node.address}${accumulatedTokens ? ' (continuation)' : ''}`);
          this.lastStreamAgentAddress = node.address;
          for await (const chunk of this.agentRelay.sendStreamRequest(node.address, effectiveRequest)) {
            accumulatedTokens += chunk;
            yield chunk;
          }
          node.consecutiveFailures = 0;
          return;
        }

        // HTTP node
        const streamTimeout = 120000;
        const client = axios.create({
          baseURL: node.url,
          timeout: streamTimeout,
          headers: { 'Content-Type': 'application/json' },
        });

        if (node.nodeType === 'openai' || node.nodeType === 'unknown') {
          this.logger.debug(`[attempt ${attempt + 1}/${maxRetries}] Streaming from OpenAI-compatible node: ${node.url}${accumulatedTokens ? ' (continuation)' : ''}`);

          // Build messages: use effectiveRequest for continuation
          const messages = effectiveRequest.messages?.length
            ? effectiveRequest.messages
            : [{ role: 'user', content: effectiveRequest.inputs }];

          const response = await client.post(
            '/v1/chat/completions',
            {
              model: this.currentModel,
              messages,
              max_tokens: effectiveRequest.parameters?.max_new_tokens || 512,
              temperature: effectiveRequest.parameters?.temperature || 0.7,
              top_p: effectiveRequest.parameters?.top_p || 0.9,
              stream: true,
            },
            { responseType: 'stream' },
          );

          node.consecutiveFailures = 0;
          node.nodeType = 'openai';
          this.lastStreamAgentAddress = node.address;

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
                    accumulatedTokens += content;
                    yield content;
                  }
                } catch {
                  // skip unparseable chunks
                }
              }
            }
          }

          return;
        } else if (node.nodeType === 'pipeline') {
          this.logger.debug(`[attempt ${attempt + 1}/${maxRetries}] Streaming from pipeline node: ${node.url}${accumulatedTokens ? ' (continuation)' : ''}`);
          const response = await client.post<any>(
            '/api/v1/generate',
            { ...effectiveRequest, stream: true },
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
                    accumulatedTokens += parsed.token;
                    yield parsed.token;
                  } else if (parsed.error) {
                    throw new Error(parsed.error);
                  }
                } catch (parseErr) {
                  accumulatedTokens += data;
                  yield data;
                }
              }
            }
          }

          return;
        }
      } catch (error) {
        lastError = error as Error;
        this.markNodeFailed(node);

        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
            node.status = 'offline';
          }

          // If OpenAI 404 on unknown node, mark as pipeline (will be retried on next select)
          if (error.response?.status === 404 && node.nodeType === 'unknown') {
            node.nodeType = 'pipeline';
          }
        }

        const tokenInfo = accumulatedTokens ? ` (${accumulatedTokens.length} chars accumulated, will continue)` : '';
        this.logger.warn(`[attempt ${attempt + 1}/${maxRetries}] Node ${node.url} stream failed: ${lastError.message}${tokenInfo}, re-selecting`);
      } finally {
        this.inFlight.release(node.url);
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
