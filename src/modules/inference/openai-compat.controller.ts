import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InferenceService } from './inference.service';
import { ModelService } from '../model/model.service';
import { InferenceRequest } from '../../common/interfaces';

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
    @Headers('authorization') authHeader?: string,
  ): Promise<OpenAIChatResponse> {
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    if (apiKey) {
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
    }

    if (!body.model) {
      throw new HttpException(
        {
          error: {
            message: 'model is required',
            type: 'invalid_request_error',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.messages || body.messages.length === 0) {
      throw new HttpException(
        {
          error: {
            message: 'messages is required and must not be empty',
            type: 'invalid_request_error',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const inferenceRequest: InferenceRequest = {
        model: body.model,
        messages: body.messages,
        max_tokens: body.max_tokens || 512,
        temperature: body.temperature ?? 0.7,
        top_p: body.top_p ?? 0.9,
        stream: false,
      };

      const result = await this.inferenceService.runInference(
        inferenceRequest,
        'openai-compat',
        'pro',
      );

      const responseContent = result.choices[0]?.message?.content || '';

      const response: OpenAIChatResponse = {
        id: `chatcmpl-${result.id}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
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

      return response;
    } catch (error) {
      throw new HttpException(
        {
          error: {
            message: error.message || 'Internal server error',
            type: 'internal_error',
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('models')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List available models (OpenAI-compatible)' })
  listModels(
    @Headers('authorization') authHeader?: string,
  ): OpenAIModelListResponse {
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    if (apiKey) {
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
    }

    const models = this.modelService.getAllModels();

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
