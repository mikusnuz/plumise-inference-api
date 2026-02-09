import { Module } from '@nestjs/common';
import { InferenceController } from './inference.controller';
import { InferenceService } from './inference.service';
import { InferenceGateway } from './inference.gateway';
import { ModelModule } from '../model/model.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [ModelModule, RateLimitModule, PaymentModule],
  controllers: [InferenceController],
  providers: [InferenceService, InferenceGateway],
  exports: [InferenceService],
})
export class InferenceModule {}
