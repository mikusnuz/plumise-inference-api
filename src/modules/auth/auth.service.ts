import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ChainService } from '../chain/chain.service';
import { generateNonce } from '../../common/utils';
import { JwtPayload } from '../../common/interfaces';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly nonces = new Map<string, { nonce: string; expiresAt: number }>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly chainService: ChainService,
  ) {
    setInterval(() => this.cleanupExpiredNonces(), 60000);
  }

  generateNonce(address: string): string {
    const nonce = generateNonce();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    this.nonces.set(address.toLowerCase(), { nonce, expiresAt });
    this.logger.log(`Generated nonce for ${address}`);

    return nonce;
  }

  async verifySignature(address: string, signature: string): Promise<string> {
    const normalizedAddress = address.toLowerCase();
    const nonceData = this.nonces.get(normalizedAddress);

    if (!nonceData) {
      throw new UnauthorizedException('Nonce not found or expired');
    }

    if (Date.now() > nonceData.expiresAt) {
      this.nonces.delete(normalizedAddress);
      throw new UnauthorizedException('Nonce expired');
    }

    const message = `Sign this message to authenticate with Plumise Inference API.\n\nNonce: ${nonceData.nonce}`;
    const isValid = await this.chainService.verifySignature(
      message,
      signature,
      address,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid signature');
    }

    this.nonces.delete(normalizedAddress);

    const payload: JwtPayload = { address: normalizedAddress };
    const token = this.jwtService.sign(payload);

    this.logger.log(`Authenticated ${address}`);
    return token;
  }

  private cleanupExpiredNonces() {
    const now = Date.now();
    for (const [address, data] of this.nonces.entries()) {
      if (now > data.expiresAt) {
        this.nonces.delete(address);
      }
    }
  }
}
