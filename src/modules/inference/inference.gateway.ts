import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InferenceService } from './inference.service';
import { PaymentService } from '../payment/payment.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';

@WebSocketGateway({
  namespace: '/ws/inference',
  cors: {
    origin: process.env.CORS_ORIGINS?.split(',').filter(o => o !== '*') || ['http://localhost:3000'],
  },
})
export class InferenceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InferenceGateway.name);

  constructor(
    private readonly inferenceService: InferenceService,
    private readonly jwtService: JwtService,
    private readonly paymentService: PaymentService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Connection rejected: No token provided (${client.id})`);
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      (client as any).user = { address: payload.address };
      (client as any).userTier = await this.paymentService.getUserTier(payload.address);

      this.logger.log(`Client connected: ${client.id} (${payload.address})`);
    } catch (error) {
      this.logger.warn(`Connection rejected: Invalid token (${client.id})`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const user = (client as any).user;
    this.logger.log(`Client disconnected: ${client.id}${user ? ` (${user.address})` : ''}`);
  }

  @SubscribeMessage('inference')
  async handleInference(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const user = (client as any).user;
      const tier = (client as any).userTier || 'free';

      if (!user || !user.address) {
        throw new UnauthorizedException('Authentication required');
      }

      const allowed = this.rateLimitService.checkRateLimit(user.address, tier);
      if (!allowed) {
        client.emit('inference_error', {
          statusCode: 429,
          message: 'Rate limit exceeded',
          details: this.rateLimitService.getUsageStats(user.address),
        });
        return;
      }

      this.logger.log(`WebSocket inference from ${user.address}`);

      const response = await this.inferenceService.runInference(
        data,
        user.address,
        tier,
      );

      client.emit('inference_response', response);
    } catch (error) {
      const isDev = process.env.NODE_ENV !== 'production';
      this.logger.error('WebSocket inference error:', isDev && error instanceof Error ? error.stack : error instanceof Error ? error.message : 'Unknown error');
      client.emit('inference_error', {
        message: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }

  @SubscribeMessage('inference_stream')
  async handleStreamInference(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const user = (client as any).user;
      const tier = (client as any).userTier || 'free';

      if (!user || !user.address) {
        throw new UnauthorizedException('Authentication required');
      }

      const allowed = this.rateLimitService.checkRateLimit(user.address, tier);
      if (!allowed) {
        client.emit('inference_error', {
          statusCode: 429,
          message: 'Rate limit exceeded',
          details: this.rateLimitService.getUsageStats(user.address),
        });
        return;
      }

      this.logger.log(`WebSocket stream inference from ${user.address}`);

      for await (const chunk of this.inferenceService.streamInference(
        data,
        user.address,
        tier,
      )) {
        client.emit('inference_chunk', { data: chunk });
      }

      client.emit('inference_complete', { status: 'done' });
    } catch (error) {
      const isDev = process.env.NODE_ENV !== 'production';
      this.logger.error('WebSocket stream inference error:', isDev && error instanceof Error ? error.stack : error instanceof Error ? error.message : 'Unknown error');
      client.emit('inference_error', {
        message: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }
}
