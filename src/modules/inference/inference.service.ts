import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ModelService } from '../model/model.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { InferenceRequest, InferenceResponse } from '../../common/interfaces';
import { generateRequestId, estimateTokens } from '../../common/utils';

@Injectable()
export class InferenceService {
  private readonly logger = new Logger(InferenceService.name);
  private readonly petalsApiUrl = process.env.PETALS_API_URL || 'http://localhost:31330';

  constructor(
    private readonly modelService: ModelService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async runInference(
    request: InferenceRequest,
    userAddress: string,
    tier: 'free' | 'pro',
  ): Promise<InferenceResponse> {
    const model = this.modelService.getModel(request.model);

    if (!model) {
      throw new BadRequestException(`Model ${request.model} not found`);
    }

    if (model.tier === 'pro' && tier === 'free') {
      throw new BadRequestException(`Model ${request.model} requires Pro tier`);
    }

    if (!this.modelService.isModelAvailable(request.model)) {
      throw new ServiceUnavailableException(`Model ${request.model} is currently unavailable`);
    }

    const maxTokens = tier === 'free'
      ? parseInt(process.env.FREE_TIER_MAX_TOKENS || '2048')
      : parseInt(process.env.PRO_TIER_MAX_TOKENS || '4096');

    if (request.max_tokens > maxTokens) {
      throw new BadRequestException(
        `max_tokens exceeds limit for ${tier} tier (${maxTokens})`,
      );
    }

    const requestId = generateRequestId();
    this.logger.log(`Inference request ${requestId} from ${userAddress}: model=${request.model}`);

    // TODO: Actually call Petals network API
    // For now, return mock response
    const promptText = request.prompt || request.messages?.map(m => m.content).join('\n') || '';
    const promptTokens = estimateTokens(promptText);
    const completionText = 'This is a mock response. Petals network integration pending.';
    const completionTokens = estimateTokens(completionText);

    this.rateLimitService.incrementUsage(userAddress);

    const response: InferenceResponse = {
      id: requestId,
      model: request.model,
      choices: [
        {
          text: request.prompt ? completionText : undefined,
          message: request.messages
            ? { role: 'assistant', content: completionText }
            : undefined,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    return response;
  }

  async *streamInference(
    request: InferenceRequest,
    userAddress: string,
    tier: 'free' | 'pro',
  ): AsyncGenerator<string> {
    // TODO: Implement streaming via Petals
    const response = await this.runInference(request, userAddress, tier);
    yield JSON.stringify(response);
  }
}
