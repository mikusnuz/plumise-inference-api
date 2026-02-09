import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { InferenceService } from './inference.service';
import { WalletAuthGuard } from '../auth/auth.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@WebSocketGateway({
  namespace: '/ws/inference',
  cors: {
    origin: process.env.CORS_ORIGINS?.split(',') || '*',
  },
})
export class InferenceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InferenceGateway.name);

  constructor(private readonly inferenceService: InferenceService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('inference')
  @UseGuards(WalletAuthGuard, RateLimitGuard)
  async handleInference(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const user = (client as any).user;
      const tier = (client as any).userTier || 'free';

      this.logger.log(`WebSocket inference from ${user?.address || 'unknown'}`);

      const response = await this.inferenceService.runInference(
        data,
        user?.address || '',
        tier,
      );

      client.emit('inference_response', response);
    } catch (error) {
      this.logger.error('WebSocket inference error:', error);
      client.emit('inference_error', {
        message: error.message || 'Internal server error',
      });
    }
  }

  @SubscribeMessage('inference_stream')
  @UseGuards(WalletAuthGuard, RateLimitGuard)
  async handleStreamInference(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const user = (client as any).user;
      const tier = (client as any).userTier || 'free';

      this.logger.log(`WebSocket stream inference from ${user?.address || 'unknown'}`);

      for await (const chunk of this.inferenceService.streamInference(
        data,
        user?.address || '',
        tier,
      )) {
        client.emit('inference_chunk', { data: chunk });
      }

      client.emit('inference_complete', { status: 'done' });
    } catch (error) {
      this.logger.error('WebSocket stream inference error:', error);
      client.emit('inference_error', {
        message: error.message || 'Internal server error',
      });
    }
  }
}
