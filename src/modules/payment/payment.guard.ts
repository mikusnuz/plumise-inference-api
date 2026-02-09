import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Injectable()
export class ProTierGuard implements CanActivate {
  constructor(private readonly paymentService: PaymentService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.address) {
      throw new ForbiddenException('Authentication required');
    }

    const tier = await this.paymentService.getUserTier(user.address);

    if (tier !== 'pro') {
      throw new ForbiddenException('Pro tier required for this resource');
    }

    return true;
  }
}
