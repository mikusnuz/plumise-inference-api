import { Controller, Post, Get, Body, UseGuards, Req, Sse } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Observable, from } from 'rxjs';
import { InferenceService } from './inference.service';
import { WalletAuthGuard } from '../auth/auth.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { InferenceRequestDto } from './dto/inference-request.dto';
import { InferenceResponseDto } from './dto/inference-response.dto';

@ApiTags('inference')
@Controller('api/v1/inference')
@UseGuards(WalletAuthGuard, RateLimitGuard)
@ApiBearerAuth()
export class InferenceController {
  constructor(private readonly inferenceService: InferenceService) {}

  @Post()
  @ApiOperation({ summary: 'Run text completion inference' })
  async runInference(
    @Body() request: InferenceRequestDto,
    @CurrentUser() user: { address: string },
    @Req() req: any,
  ): Promise<InferenceResponseDto> {
    const tier = req.userTier || 'free';
    return await this.inferenceService.runInference(request, user.address, tier);
  }

  @Post('chat')
  @ApiOperation({ summary: 'Run chat completion inference' })
  async runChatInference(
    @Body() request: InferenceRequestDto,
    @CurrentUser() user: { address: string },
    @Req() req: any,
  ): Promise<InferenceResponseDto> {
    const tier = req.userTier || 'free';
    return await this.inferenceService.runInference(request, user.address, tier);
  }

  @Get('stream')
  @Sse()
  @ApiOperation({ summary: 'Stream inference results via SSE' })
  streamInference(
    @Body() request: InferenceRequestDto,
    @CurrentUser() user: { address: string },
    @Req() req: any,
  ): Observable<any> {
    const tier = req.userTier || 'free';

    return from(
      (async function* () {
        for await (const chunk of this.inferenceService.streamInference(
          request,
          user.address,
          tier,
        )) {
          yield { data: chunk };
        }
      }).call(this),
    );
  }
}
