import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { InferenceService } from './inference.service';
import { ModelService } from '../model/model.service';
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
const MAX_CONTEXT_TOKENS = 28672; // 32768 ctx - 4096 reserved for response

function estimateMessageTokens(messages: OpenAIChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // ~4 chars per token + 4 tokens overhead per message (role, delimiters)
    total += Math.ceil(msg.content.length / 4) + 4;
  }
  return total;
}

function trimMessages(messages: OpenAIChatMessage[], maxTokens: number): OpenAIChatMessage[] {
  if (estimateMessageTokens(messages) <= maxTokens) return messages;

  // Separate system messages (keep all) from conversation messages
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const convMsgs = messages.filter((m) => m.role !== 'system');

  let budget = maxTokens - estimateMessageTokens(systemMsgs);
  // Add conversation messages from newest to oldest
  const kept: OpenAIChatMessage[] = [];
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    const cost = Math.ceil(convMsgs[i].content.length / 4) + 4;
    if (budget - cost < 0) break;
    kept.unshift(convMsgs[i]);
    budget -= cost;
  }

  return [...systemMsgs, ...kept];
}

@ApiTags('openai-compat')
@Controller('v1')
export class OpenAICompatController {
  constructor(
    private readonly inferenceService: InferenceService,
    private readonly modelService: ModelService,
  ) {}

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

      const trimmedMessages = trimMessages(messages, MAX_CONTEXT_TOKENS);

      const inferenceRequest: InferenceRequest = {
        model: body.model,
        messages: trimmedMessages,
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

        try {
          for await (const chunk of this.inferenceService.streamInference(
            inferenceRequest,
            'openai-compat',
            'pro',
          )) {
            const cleaned = stripChannelTokens(chunk);
            if (cleaned) {
              res.write(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: body.model,
                choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }],
              })}\n\n`);
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
