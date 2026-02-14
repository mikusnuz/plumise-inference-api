import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { InferenceController } from './inference.controller';
import { InferenceService } from './inference.service';
import { InferenceGateway } from './inference.gateway';
import { NodeRouterService } from './node-router.service';
import { AgentRelayService } from './agent-relay.service';
import { OpenAICompatController } from './openai-compat.controller';
import { ModelModule } from '../model/model.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PaymentModule } from '../payment/payment.module';
import { ChainModule } from '../chain/chain.module';

@Module({
  imports: [
    ModelModule,
    RateLimitModule,
    PaymentModule,
    ChainModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || (() => {
        throw new Error('JWT_SECRET must be set in environment variables');
      })(),
      signOptions: { expiresIn: process.env.JWT_EXPIRATION as any || '24h' },
    }),
  ],
  controllers: [InferenceController, OpenAICompatController],
  providers: [
    InferenceService,
    InferenceGateway,
    NodeRouterService,
    AgentRelayService,
  ],
  exports: [InferenceService],
})
export class InferenceModule {}
