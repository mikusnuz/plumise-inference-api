import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as WebSocket from 'ws';
import { ChainService } from '../chain/chain.service';
import { AgentGenerateRequest, AgentGenerateResponse } from './node-router.service';
import { stripChannelTokens } from '../../common/utils';

interface ConnectedAgent {
  ws: WebSocket;
  address: string;
  model: string;
  connectedAt: number;
}

interface PendingRequest {
  resolve: (value: AgentGenerateResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  agentAddress: string;
}

interface PendingStreamRequest {
  onChunk: (content: string) => void;
  onDone: (usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  onError: (error: Error) => void;
  timer: NodeJS.Timeout;
  agentAddress: string;
}

@Injectable()
export class AgentRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRelayService.name);
  private wss: WebSocket.Server | null = null;
  private agents: Map<string, ConnectedAgent> = new Map(); // address → connection
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private pendingStreams: Map<string, PendingStreamRequest> = new Map();
  private readonly AUTH_TIMEOUT = 10000; // 10s
  private readonly REQUEST_TIMEOUT = 120000; // 2min
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly chainService: ChainService,
  ) {}

  onModuleInit() {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    this.wss = new WebSocket.Server({
      server: httpServer,
      path: '/ws/agent-relay',
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    // Ping connected agents every 30s to detect dead connections
    this.pingInterval = setInterval(() => {
      for (const [address, agent] of this.agents.entries()) {
        if (agent.ws.readyState === WebSocket.OPEN) {
          agent.ws.ping();
        } else {
          this.logger.warn(`Agent ${address} connection dead, removing`);
          this.agents.delete(address);
        }
      }
    }, 30000);

    this.logger.log('Agent relay WebSocket server started on /ws/agent-relay');
  }

  onModuleDestroy() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    // Clean up pending requests
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('Service shutting down'));
    }
    this.pendingRequests.clear();
    for (const [id, stream] of this.pendingStreams.entries()) {
      clearTimeout(stream.timer);
      stream.onError(new Error('Service shutting down'));
    }
    this.pendingStreams.clear();

    if (this.wss) {
      this.wss.close();
    }
  }

  private handleConnection(ws: WebSocket) {
    this.logger.log('New agent connection, awaiting auth...');

    // Auth timeout: disconnect if no auth within 10s
    const authTimer = setTimeout(() => {
      this.logger.warn('Agent auth timeout, disconnecting');
      ws.close(4001, 'Auth timeout');
    }, this.AUTH_TIMEOUT);

    let authenticated = false;
    let agentAddress = '';

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (!authenticated) {
          // Expect auth message
          if (msg.type === 'auth') {
            clearTimeout(authTimer);
            const result = await this.handleAuth(ws, msg);
            if (result) {
              authenticated = true;
              agentAddress = result;
            }
          } else {
            ws.close(4002, 'Expected auth message');
          }
          return;
        }

        // Authenticated — handle messages
        this.handleMessage(agentAddress, msg);
      } catch (error) {
        this.logger.error(
          `Message parse error: ${error instanceof Error ? error.message : 'Unknown'}`,
        );
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (agentAddress) {
        this.logger.log(`Agent ${agentAddress} disconnected`);
        this.agents.delete(agentAddress);
        // Reject any pending requests for this agent
        this.rejectPendingForAgent(agentAddress);
      }
    });

    ws.on('error', (error) => {
      this.logger.error(`Agent WS error: ${error.message}`);
    });
  }

  private async handleAuth(
    ws: WebSocket,
    msg: { address: string; model: string; timestamp: number; signature: string },
  ): Promise<string | null> {
    const { address, model, timestamp, signature } = msg;

    if (!address || !model || !timestamp || !signature) {
      this.sendJson(ws, { type: 'auth_error', message: 'Missing auth fields' });
      ws.close(4003, 'Missing auth fields');
      return null;
    }

    // Check timestamp freshness (allow 5 min drift)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      this.sendJson(ws, { type: 'auth_error', message: 'Timestamp too old or too far in future' });
      ws.close(4004, 'Timestamp drift');
      return null;
    }

    // Verify EIP-191 signature
    const signMessage = JSON.stringify({ address, model, timestamp });
    const isValid = await this.chainService.verifySignature(
      signMessage,
      signature,
      address,
    );

    if (!isValid) {
      this.sendJson(ws, { type: 'auth_error', message: 'Invalid signature' });
      ws.close(4005, 'Invalid signature');
      return null;
    }

    // Close existing connection for same address (if any)
    const existing = this.agents.get(address.toLowerCase());
    if (existing) {
      this.logger.warn(`Agent ${address} reconnecting, closing old connection`);
      existing.ws.close(4010, 'Replaced by new connection');
      this.agents.delete(address.toLowerCase());
    }

    // Register agent
    this.agents.set(address.toLowerCase(), {
      ws,
      address: address.toLowerCase(),
      model,
      connectedAt: Date.now(),
    });

    this.sendJson(ws, { type: 'auth_ok' });
    this.logger.log(`Agent authenticated: ${address} (model: ${model})`);
    return address.toLowerCase();
  }

  private handleMessage(agentAddress: string, msg: any) {
    switch (msg.type) {
      case 'response': {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          pending.resolve({
            generated_text: stripChannelTokens(msg.choices?.[0]?.message?.content || ''),
            num_tokens: msg.usage?.completion_tokens,
          });
        }
        break;
      }

      case 'chunk': {
        const stream = this.pendingStreams.get(msg.id);
        if (stream) {
          // Reset timeout on each chunk (model is still producing)
          clearTimeout(stream.timer);
          stream.timer = setTimeout(() => {
            this.pendingStreams.delete(msg.id);
            stream.onError(new Error('Stream timeout'));
          }, this.REQUEST_TIMEOUT);
          stream.onChunk(msg.content || '');
        }
        break;
      }

      case 'done': {
        const stream = this.pendingStreams.get(msg.id);
        if (stream) {
          clearTimeout(stream.timer);
          this.pendingStreams.delete(msg.id);
          stream.onDone(msg.usage);
        }
        break;
      }

      case 'error': {
        // Agent reports error for a request
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          pending.reject(new Error(msg.message || 'Agent error'));
        }
        const stream = this.pendingStreams.get(msg.id);
        if (stream) {
          clearTimeout(stream.timer);
          this.pendingStreams.delete(msg.id);
          stream.onError(new Error(msg.message || 'Agent stream error'));
        }
        break;
      }

      case 'ping': {
        const agent = this.agents.get(agentAddress);
        if (agent) {
          this.sendJson(agent.ws, { type: 'pong' });
        }
        break;
      }

      default:
        this.logger.debug(`Unknown message type from ${agentAddress}: ${msg.type}`);
    }
  }

  private rejectPendingForAgent(address: string) {
    const addr = address.toLowerCase();
    const disconnectError = new Error(`Agent ${address} disconnected`);

    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.agentAddress === addr) {
        clearTimeout(req.timer);
        this.pendingRequests.delete(id);
        req.reject(disconnectError);
        this.logger.warn(`Rejected pending request ${id} — agent disconnected`);
      }
    }
    for (const [id, stream] of this.pendingStreams.entries()) {
      if (stream.agentAddress === addr) {
        clearTimeout(stream.timer);
        this.pendingStreams.delete(id);
        stream.onError(disconnectError);
        this.logger.warn(`Rejected pending stream ${id} — agent disconnected`);
      }
    }
  }

  // ---- Public API for NodeRouterService ----

  getConnectedAgents(): { address: string; model: string }[] {
    return Array.from(this.agents.values()).map((a) => ({
      address: a.address,
      model: a.model,
    }));
  }

  hasConnectedAgents(): boolean {
    return this.agents.size > 0;
  }

  async sendRequest(
    address: string,
    request: AgentGenerateRequest,
  ): Promise<AgentGenerateResponse> {
    const agent = this.agents.get(address.toLowerCase());
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Agent ${address} not connected`);
    }

    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, this.REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timer, agentAddress: address.toLowerCase() });

      // Prefer original chat messages; fall back to wrapping inputs as user message
      const messages = request.messages?.length
        ? request.messages
        : [{ role: 'user', content: request.inputs }];
      this.sendJson(agent.ws, {
        type: 'request',
        id,
        messages,
        maxTokens: request.parameters?.max_new_tokens || 4096,
        temperature: request.parameters?.temperature || 0.7,
        topP: request.parameters?.top_p || 0.9,
        stream: false,
      });
    });
  }

  async *sendStreamRequest(
    address: string,
    request: AgentGenerateRequest,
  ): AsyncGenerator<string> {
    const agent = this.agents.get(address.toLowerCase());
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Agent ${address} not connected`);
    }

    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Create a queue for chunks
    const chunks: string[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveWait: (() => void) | null = null;

    const timer = setTimeout(() => {
      this.pendingStreams.delete(id);
      error = new Error('Stream timeout');
      if (resolveWait) resolveWait();
    }, this.REQUEST_TIMEOUT);

    this.pendingStreams.set(id, {
      onChunk: (content: string) => {
        chunks.push(content);
        if (resolveWait) resolveWait();
      },
      onDone: () => {
        done = true;
        if (resolveWait) resolveWait();
      },
      onError: (err: Error) => {
        error = err;
        if (resolveWait) resolveWait();
      },
      timer,
      agentAddress: address.toLowerCase(),
    });

    // Prefer original chat messages; fall back to wrapping inputs as user message
    const messages = request.messages?.length
      ? request.messages
      : [{ role: 'user', content: request.inputs }];
    this.sendJson(agent.ws, {
      type: 'request',
      id,
      messages,
      maxTokens: request.parameters?.max_new_tokens || 4096,
      temperature: request.parameters?.temperature || 0.7,
      topP: request.parameters?.top_p || 0.9,
      stream: true,
    });

    // Yield chunks as they arrive (pass through directly)
    while (!done && !error) {
      if (chunks.length > 0) {
        const chunk = chunks.shift()!;
        if (chunk) yield chunk;
      } else {
        // Wait for next chunk
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
        resolveWait = null;
      }
    }

    // Yield remaining chunks
    while (chunks.length > 0) {
      const chunk = chunks.shift()!;
      if (chunk) yield chunk;
    }

    if (error) {
      throw error;
    }
  }

  private sendJson(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
