import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { ChainModule } from '../chain/chain.module';

@Module({
  imports: [ChainModule],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
