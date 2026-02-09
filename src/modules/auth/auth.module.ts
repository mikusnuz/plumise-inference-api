import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { WalletStrategy } from './strategies/wallet.strategy';
import { ChainModule } from '../chain/chain.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-jwt-secret',
      signOptions: { expiresIn: '24h' },
    }),
    ChainModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, WalletStrategy],
  exports: [AuthService],
})
export class AuthModule {}
