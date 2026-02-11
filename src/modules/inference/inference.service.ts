import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ModelService } from '../model/model.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { InferenceRequest, InferenceResponse, ChatMessage } from '../../common/interfaces';
import { generateRequestId, estimateTokens } from '../../common/utils';
import { PetalsClientService } from './petals-client.service';
import { MetricsReporterService } from './metrics-reporter.service';

@Injectable()
export class InferenceService {
  private readonly logger = new Logger(InferenceService.name);

  constructor(
    private readonly modelService: ModelService,
    private readonly rateLimitService: RateLimitService,
    private readonly petalsClient: PetalsClientService,
    private readonly metricsReporter: MetricsReporterService,
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

    const startTime = Date.now();

    let promptText: string;
    if (request.messages) {
      promptText = this.formatChatMessages(request.messages);
    } else if (request.prompt) {
      promptText = request.prompt;
    } else {
      throw new BadRequestException('Either prompt or messages must be provided');
    }

    const promptTokens = estimateTokens(promptText);

    try {
      const petalsResponse = await this.petalsClient.generate({
        inputs: promptText,
        parameters: {
          max_new_tokens: request.max_tokens,
          temperature: request.temperature ?? 0.7,
          top_p: request.top_p ?? 0.9,
          do_sample: true,
        },
      });

      const latencyMs = Date.now() - startTime;
      const completionText = petalsResponse.generated_text;
      const completionTokens = petalsResponse.num_tokens || estimateTokens(completionText);
      const totalTokens = promptTokens + completionTokens;

      this.metricsReporter.recordInference(totalTokens, latencyMs);
      this.rateLimitService.incrementUsage(userAddress);

      this.logger.log(
        `Inference ${requestId} completed: ${totalTokens} tokens, ${latencyMs}ms`,
      );

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
          total_tokens: totalTokens,
        },
      };

      return response;
    } catch (error) {
      this.logger.error(`Inference ${requestId} failed: ${error.message}`);
      throw error;
    }
  }

  private formatChatMessages(messages: ChatMessage[]): string {
    return messages
      .map((msg) => {
        const role = msg.role.toUpperCase();
        return `### ${role}:\n${msg.content}\n`;
      })
      .join('\n') + '\n### ASSISTANT:\n';
  }

  async *streamInference(
    request: InferenceRequest,
    userAddress: string,
    tier: 'free' | 'pro',
  ): AsyncGenerator<string> {
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
    this.logger.log(`Streaming inference ${requestId} from ${userAddress}: model=${request.model}`);

    const startTime = Date.now();

    let promptText: string;
    if (request.messages) {
      promptText = this.formatChatMessages(request.messages);
    } else if (request.prompt) {
      promptText = request.prompt;
    } else {
      throw new BadRequestException('Either prompt or messages must be provided');
    }

    const promptTokens = estimateTokens(promptText);

    try {
      let completedText = '';

      for await (const chunk of this.petalsClient.generateStream({
        inputs: promptText,
        parameters: {
          max_new_tokens: request.max_tokens,
          temperature: request.temperature ?? 0.7,
          top_p: request.top_p ?? 0.9,
          do_sample: true,
        },
      })) {
        completedText += chunk;
        yield chunk;
      }

      const latencyMs = Date.now() - startTime;
      const completionTokens = estimateTokens(completedText);
      const totalTokens = promptTokens + completionTokens;

      this.metricsReporter.recordInference(totalTokens, latencyMs);
      this.rateLimitService.incrementUsage(userAddress);

      this.logger.log(
        `Streaming inference ${requestId} completed: ${totalTokens} tokens, ${latencyMs}ms`,
      );
    } catch (error) {
      this.logger.error(`Streaming inference ${requestId} failed: ${error.message}`);
      throw error;
    }
  }
}
