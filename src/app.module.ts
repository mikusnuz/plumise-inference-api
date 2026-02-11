import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChainModule } from './modules/chain/chain.module';
import { AuthModule } from './modules/auth/auth.module';
import { PaymentModule } from './modules/payment/payment.module';
import { RateLimitModule } from './modules/rate-limit/rate-limit.module';
import { ModelModule } from './modules/model/model.module';
import { InferenceModule } from './modules/inference/inference.module';
import { ReportModule } from './modules/report/report.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ChainModule,
    AuthModule,
    PaymentModule,
    RateLimitModule,
    ModelModule,
    InferenceModule,
    ReportModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
