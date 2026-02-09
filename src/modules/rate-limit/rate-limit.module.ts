import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [PaymentModule],
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
