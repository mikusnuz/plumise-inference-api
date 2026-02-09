import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { PaymentService } from '../payment/payment.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly paymentService: PaymentService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.address) {
      throw new HttpException('Authentication required', HttpStatus.UNAUTHORIZED);
    }

    const tier = await this.paymentService.getUserTier(user.address);
    const allowed = this.rateLimitService.checkRateLimit(user.address, tier);

    if (!allowed) {
      const stats = this.rateLimitService.getUsageStats(user.address);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Rate limit exceeded',
          error: 'Too Many Requests',
          details: stats,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    request.userTier = tier;
    return true;
  }
}
