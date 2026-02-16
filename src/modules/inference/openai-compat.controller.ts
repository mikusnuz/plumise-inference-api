import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Res,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { InferenceService } from './inference.service';
import { ModelService } from '../model/model.service';
import { NodeRouterService } from './node-router.service';
import { InferenceRequest } from '../../common/interfaces';
import { stripChannelTokens } from '../../common/utils';

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelListResponse {
  object: string;
  data: {
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }[];
}

// Context budget: reserve tokens for completion, trim old messages if needed
const MAX_CONTEXT_TOKENS = 24576; // 32768 ctx - 8192 reserved for response (generous margin)
const SUMMARY_TRIGGER_RATIO = 0.6; // Summarize when messages use > 60% of budget

/**
 * Estimate token count for multi-language text.
 * ASCII: ~4 chars/token, CJK (Korean/Chinese/Japanese): ~1.5 chars/token.
 * Previous version used text.length/4 which severely underestimated CJK text (6-8x).
 */
function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x7F) {
      // ASCII: ~4 chars per token
      count += 0.25;
    } else if (code <= 0x7FF) {
      // Extended Latin, Cyrillic, etc: ~2 chars per token
      count += 0.5;
    } else {
      // CJK, Korean, emoji, etc: ~1-2 chars per token (use 1.5 avg)
      count += 1.5;
    }
  }
  return Math.ceil(count) + 4; // +4 for special tokens overhead
}

function estimateMessageTokens(messages: OpenAIChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
  }
  return total;
}

/** Simple fallback: drop oldest non-system messages */
function trimMessages(messages: OpenAIChatMessage[], maxTokens: number): OpenAIChatMessage[] {
  if (estimateMessageTokens(messages) <= maxTokens) return messages;

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const convMsgs = messages.filter((m) => m.role !== 'system');

  let budget = maxTokens - estimateMessageTokens(systemMsgs);
  const kept: OpenAIChatMessage[] = [];
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    const cost = estimateTokens(convMsgs[i].content);
    if (budget - cost < 0) break;
    kept.unshift(convMsgs[i]);
    budget -= cost;
  }

  return [...systemMsgs, ...kept];
}

@ApiTags('openai-compat')
@Controller('v1')
export class OpenAICompatController {
  private readonly logger = new Logger(OpenAICompatController.name);

  constructor(
    private readonly inferenceService: InferenceService,
    private readonly modelService: ModelService,
    private readonly nodeRouter: NodeRouterService,
  ) {}

  /**
   * Summarize old messages via LLM when conversation exceeds context budget.
   * Returns [system msgs] + [summary as system msg] + [recent conversation msgs].
   * Falls back to simple trimming on failure.
   */
  private async summarizeIfNeeded(messages: OpenAIChatMessage[]): Promise<OpenAIChatMessage[]> {
    const totalEstimate = estimateMessageTokens(messages);
    this.logger.log(
      `Context check: ${messages.length} messages, ~${totalEstimate} est. tokens (budget: ${MAX_CONTEXT_TOKENS})`,
    );
    if (totalEstimate <= MAX_CONTEXT_TOKENS) return messages;

    const systemMsgs = messages.filter((m) => m.role === 'system');
    const convMsgs = messages.filter((m) => m.role !== 'system');

    if (convMsgs.length <= 2) {
      return trimMessages(messages, MAX_CONTEXT_TOKENS);
    }

    // Split: keep recent messages within 40% budget, summarize the rest
    const recentBudget = Math.floor(MAX_CONTEXT_TOKENS * 0.4);
    const recent: OpenAIChatMessage[] = [];
    let recentCost = 0;
    for (let i = convMsgs.length - 1; i >= 0; i--) {
      const cost = estimateTokens(convMsgs[i].content);
      if (recentCost + cost > recentBudget) break;
      recent.unshift(convMsgs[i]);
      recentCost += cost;
    }

    const oldMessages = convMsgs.slice(0, convMsgs.length - recent.length);
    if (oldMessages.length === 0) {
      return trimMessages(messages, MAX_CONTEXT_TOKENS);
    }

    // Build summary prompt
    const conversationText = oldMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    try {
      this.logger.log(
        `Summarizing ${oldMessages.length} old messages (${estimateMessageTokens(oldMessages)} est. tokens)`,
      );

      const summaryResponse = await this.nodeRouter.forwardRequest({
        inputs: '',
        messages: [
          {
            role: 'system',
            content:
              'You are a conversation summarizer. Summarize the following conversation concisely, ' +
              'preserving key facts, decisions, and context. Write in the same language as the conversation. ' +
              'Output ONLY the summary, nothing else.',
          },
          { role: 'user', content: conversationText },
        ],
        parameters: { max_new_tokens: 1024, temperature: 0.3 },
      });

      const summary = stripChannelTokens(summaryResponse.generated_text).trim();
      if (!summary) {
        this.logger.warn('Summary was empty, falling back to trim');
        return trimMessages(messages, MAX_CONTEXT_TOKENS);
      }

      this.logger.log(`Summarized ${oldMessages.length} messages into ${summary.length} chars`);

      return [
        ...systemMsgs,
        {
          role: 'system' as const,
          content: `[Previous conversation summary]\n${summary}`,
        },
        ...recent,
      ];
    } catch (error) {
      this.logger.warn(`Summarization failed: ${error instanceof Error ? error.message : 'Unknown'}, falling back to trim`);
      return trimMessages(messages, MAX_CONTEXT_TOKENS);
    }
  }

  @Post('chat/completions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OpenAI-compatible chat completions endpoint' })
  async chatCompletions(
    @Body() body: OpenAIChatRequest,
    @Res() res: Response,
    @Headers('authorization') authHeader?: string,
  ): Promise<void> {
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    if (!apiKey) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: {
          message: 'OpenAI-compatible API is not configured',
          type: 'service_unavailable',
          code: 'not_configured',
        },
      });
      return;
    }

    const token = authHeader?.replace('Bearer ', '');
    if (token !== apiKey) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
      return;
    }

    if (!body.model) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          message: 'model is required',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    if (!body.messages || body.messages.length === 0) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          message: 'messages is required and must not be empty',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    try {
      // Inject identity system prompt if none provided
      const messages = [...body.messages];
      const hasSystem = messages.some((m) => m.role === 'system');
      if (!hasSystem) {
        messages.unshift({
          role: 'system',
          content:
            'You are GPT-OSS-20B, an open-source large language model developed by Plumise. ' +
            'You run on the Plumise decentralized inference network. ' +
            'Never claim to be GPT-4, ChatGPT, or any OpenAI model.',
        });
      }

      // Summarize old messages if conversation exceeds context budget
      const processedMessages = await this.summarizeIfNeeded(messages);

      const inferenceRequest: InferenceRequest = {
        model: body.model,
        messages: processedMessages,
        max_tokens: body.max_tokens || 4096,
        temperature: body.temperature ?? 0.7,
        top_p: body.top_p ?? 0.9,
        stream: false,
      };

      // --- Real SSE streaming ---
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const completionId = `chatcmpl-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);

        // Role chunk
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        })}\n\n`);

        // SSE heartbeat: keep connection alive during prefill (every 15s)
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            res.write(`: heartbeat\n\n`);
          }
        }, 15000);

        let totalChunks = 0;
        let sentChunks = 0;
        let strippedChunks = 0;
        try {
          for await (const chunk of this.inferenceService.streamInference(
            inferenceRequest,
            'openai-compat',
            'pro',
          )) {
            totalChunks++;
            const cleaned = stripChannelTokens(chunk);
            if (cleaned) {
              sentChunks++;
              res.write(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: body.model,
                choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }],
              })}\n\n`);
            } else {
              strippedChunks++;
              if (strippedChunks <= 3) {
                this.logger.debug(`Stripped chunk #${strippedChunks}: raw=${JSON.stringify(chunk).slice(0, 100)}`);
              }
            }
          }
        } catch (streamError) {
          const errMsg = streamError instanceof Error ? streamError.message : 'Stream error';
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta: { content: `\n[Error: ${errMsg}]` }, finish_reason: null }],
          })}\n\n`);
        } finally {
          clearInterval(heartbeat);
          this.logger.log(
            `Stream stats: ${totalChunks} total chunks, ${sentChunks} sent, ${strippedChunks} stripped`,
          );
        }

        // Final chunk
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // --- Non-streaming response ---
      const result = await this.inferenceService.runInference(
        inferenceRequest,
        'openai-compat',
        'pro',
      );

      const responseContent = stripChannelTokens(result.choices[0]?.message?.content || '');
      const completionId = `chatcmpl-${result.id}`;
      const created = Math.floor(Date.now() / 1000);

      const response: OpenAIChatResponse = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: responseContent,
            },
            finish_reason: result.choices[0]?.finish_reason || 'stop',
          },
        ],
        usage: {
          prompt_tokens: result.usage?.prompt_tokens || 0,
          completion_tokens: result.usage?.completion_tokens || 0,
          total_tokens: result.usage?.total_tokens || 0,
        },
      };

      res.json(response);
    } catch (error) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'internal_error',
        },
      });
    }
  }

  @Get('models')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List available models (OpenAI-compatible)' })
  listModels(
    @Headers('authorization') authHeader?: string,
  ): OpenAIModelListResponse {
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    if (!apiKey) {
      throw new HttpException(
        {
          error: {
            message: 'OpenAI-compatible API is not configured',
            type: 'service_unavailable',
            code: 'not_configured',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const token = authHeader?.replace('Bearer ', '');
    if (token !== apiKey) {
      throw new HttpException(
        {
          error: {
            message: 'Invalid API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const models = this.modelService.getAllModels().filter(m => m.status === 'available');

    return {
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'plumise',
      })),
    };
  }
}
