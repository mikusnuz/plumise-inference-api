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
      secret: process.env.JWT_SECRET || (() => {
        throw new Error('JWT_SECRET must be set in environment variables');
      })(),
      signOptions: { expiresIn: process.env.JWT_EXPIRATION as any || '24h' },
    }),
    ChainModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, WalletStrategy],
  exports: [AuthService],
})
export class AuthModule {}
