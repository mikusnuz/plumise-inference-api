import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ModelService } from '../model/model.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { PaymentService } from '../payment/payment.service';
import { InferenceRequest, InferenceResponse, ChatMessage } from '../../common/interfaces';
import { generateRequestId, estimateTokens } from '../../common/utils';
import { NodeRouterService } from './node-router.service';
import { UsageTrackerService } from './usage-tracker.service';

@Injectable()
export class InferenceService {
  private readonly logger = new Logger(InferenceService.name);

  constructor(
    private readonly modelService: ModelService,
    private readonly rateLimitService: RateLimitService,
    private readonly nodeRouter: NodeRouterService,
    private readonly paymentService: PaymentService,
    private readonly usageTracker: UsageTrackerService,
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
      const agentResponse = await this.nodeRouter.forwardRequest({
        inputs: promptText,
        messages: request.messages,
        parameters: {
          max_new_tokens: request.max_tokens,
          temperature: request.temperature ?? 0.7,
          top_p: request.top_p ?? 0.9,
          repetition_penalty: 1.3,
          do_sample: true,
        },
      });

      const latencyMs = Date.now() - startTime;
      const completionText = this.trimAtStopSequence(agentResponse.generated_text);
      const completionTokens = agentResponse.num_tokens || estimateTokens(completionText);
      const totalTokens = promptTokens + completionTokens;

      this.rateLimitService.incrementUsage(userAddress);

      if (tier === 'pro') {
        const deducted = await this.paymentService.deductCredits(userAddress, totalTokens);
        if (!deducted) {
          this.logger.warn(`Failed to deduct credits for ${userAddress}, but request succeeded`);
        }
      }

      this.logger.log(
        `Inference ${requestId} completed: ${totalTokens} tokens, ${latencyMs}ms`,
      );

      if (agentResponse.agent_address) {
        this.usageTracker.recordUsage(agentResponse.agent_address, totalTokens, latencyMs);
      }

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

  private trimAtStopSequence(text: string): string {
    const stopPatterns = ['### USER:', '### SYSTEM:', '### ASSISTANT:', 'USER:', '\n###'];
    let result = text;
    for (const stop of stopPatterns) {
      const idx = result.indexOf(stop);
      if (idx > 0) {
        result = result.substring(0, idx);
      }
    }
    return result.trim();
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

      for await (const chunk of this.nodeRouter.forwardStreamRequest({
        inputs: promptText,
        messages: request.messages,
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

      this.rateLimitService.incrementUsage(userAddress);

      if (tier === 'pro') {
        const deducted = await this.paymentService.deductCredits(userAddress, totalTokens);
        if (!deducted) {
          this.logger.warn(`Failed to deduct credits for ${userAddress}, but request succeeded`);
        }
      }

      this.logger.log(
        `Streaming inference ${requestId} completed: ${totalTokens} tokens, ${latencyMs}ms`,
      );

      const streamAgent = this.nodeRouter.lastStreamAgentAddress;
      if (streamAgent) {
        this.usageTracker.recordUsage(streamAgent, totalTokens, latencyMs);
      }
    } catch (error) {
      this.logger.error(`Streaming inference ${requestId} failed: ${error.message}`);
      throw error;
    }
  }
}
