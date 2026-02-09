import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { WalletAuthGuard } from './auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

@ApiTags('auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('nonce')
  @ApiOperation({ summary: 'Get nonce for wallet signing' })
  getNonce(@Body('address') address: string) {
    const nonce = this.authService.generateNonce(address);
    return {
      nonce,
      message: `Sign this message to authenticate with Plumise Inference API.\n\nNonce: ${nonce}`,
    };
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify signature and get JWT token' })
  async verify(
    @Body('address') address: string,
    @Body('signature') signature: string,
  ) {
    const token = await this.authService.verifySignature(address, signature);
    return { token };
  }

  @Get('me')
  @UseGuards(WalletAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser() user: { address: string }) {
    return {
      address: user.address,
      tier: 'free', // Will be determined by PaymentService
    };
  }
}
