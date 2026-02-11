import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { InferenceController } from './inference.controller';
import { InferenceService } from './inference.service';
import { InferenceGateway } from './inference.gateway';
import { NodeRouterService } from './node-router.service';
import { ModelModule } from '../model/model.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [
    ModelModule,
    RateLimitModule,
    PaymentModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || (() => {
        throw new Error('JWT_SECRET must be set in environment variables');
      })(),
      signOptions: { expiresIn: process.env.JWT_EXPIRATION as any || '24h' },
    }),
  ],
  controllers: [InferenceController],
  providers: [
    InferenceService,
    InferenceGateway,
    NodeRouterService,
  ],
  exports: [InferenceService],
})
export class InferenceModule {}
