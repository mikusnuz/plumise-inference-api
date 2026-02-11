import { Controller, Post, Get, Body, UseGuards, Req, Sse, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Observable, from } from 'rxjs';
import { InferenceService } from './inference.service';
import { NodeRouterService } from './node-router.service';
import { WalletAuthGuard } from '../auth/auth.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { InferenceRequestDto } from './dto/inference-request.dto';
import { InferenceResponseDto } from './dto/inference-response.dto';

@ApiTags('inference')
@Controller('api/v1')
export class InferenceController {
  constructor(
    private readonly inferenceService: InferenceService,
    private readonly nodeRouter: NodeRouterService,
  ) {}

  @Post('inference')
  @UseGuards(WalletAuthGuard, RateLimitGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run text completion inference' })
  async runInference(
    @Body() request: InferenceRequestDto,
    @CurrentUser() user: { address: string },
    @Req() req: any,
  ): Promise<InferenceResponseDto> {
    const tier = req.userTier || 'free';
    return await this.inferenceService.runInference(request, user.address, tier);
  }

  @Post('inference/chat')
  @UseGuards(WalletAuthGuard, RateLimitGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run chat completion inference' })
  async runChatInference(
    @Body() request: InferenceRequestDto,
    @CurrentUser() user: { address: string },
    @Req() req: any,
  ): Promise<InferenceResponseDto> {
    const tier = req.userTier || 'free';
    return await this.inferenceService.runInference(request, user.address, tier);
  }

  @Get('inference/stream')
  @UseGuards(WalletAuthGuard, RateLimitGuard)
  @ApiBearerAuth()
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

  @Get('nodes')
  @ApiOperation({ summary: 'Get list of active inference nodes' })
  getActiveNodes() {
    const nodes = this.nodeRouter.getActiveNodes();
    return {
      total: nodes.length,
      nodes: nodes.map((node) => ({
        url: node.url,
        address: node.address,
        status: node.status,
        lastHealthCheck: new Date(node.lastHealthCheck).toISOString(),
      })),
    };
  }

  @Get('nodes/:address/stats')
  @ApiOperation({ summary: 'Get statistics for a specific node' })
  @ApiParam({ name: 'address', description: 'Node wallet address' })
  getNodeStats(@Param('address') address: string) {
    const node = this.nodeRouter.getNodeStats(address);

    if (!node) {
      return {
        found: false,
        message: 'Node not found or not registered',
      };
    }

    return {
      found: true,
      node: {
        url: node.url,
        address: node.address,
        status: node.status,
        lastHealthCheck: new Date(node.lastHealthCheck).toISOString(),
        consecutiveFailures: node.consecutiveFailures,
      },
    };
  }
}
