import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface PetalsGenerateRequest {
  inputs: string;
  parameters?: {
    max_new_tokens?: number;
    temperature?: number;
    top_p?: number;
    do_sample?: boolean;
  };
}

export interface PetalsGenerateResponse {
  generated_text: string;
  num_tokens?: number;
}

@Injectable()
export class PetalsClientService {
  private readonly logger = new Logger(PetalsClientService.name);
  private readonly petalsApiUrl: string;
  private readonly client: AxiosInstance;

  constructor() {
    this.petalsApiUrl = process.env.PETALS_API_URL || 'http://localhost:31330';

    this.client = axios.create({
      baseURL: this.petalsApiUrl,
      timeout: 120000, // 2분 타임아웃
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`PetalsClient initialized with URL: ${this.petalsApiUrl}`);
  }

  async generate(request: PetalsGenerateRequest): Promise<PetalsGenerateResponse> {
    try {
      const response = await this.client.post<PetalsGenerateResponse>(
        '/api/v1/generate',
        request,
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          this.logger.error(`Petals server not reachable at ${this.petalsApiUrl}`);
          throw new ServiceUnavailableException(
            'Inference service temporarily unavailable. Please try again later.',
          );
        }

        if (error.response) {
          this.logger.error(
            `Petals API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          );
          throw new ServiceUnavailableException(
            `Inference failed: ${error.response.data?.error || 'Unknown error'}`,
          );
        }

        if (error.code === 'ECONNABORTED') {
          this.logger.error('Petals API request timeout');
          throw new ServiceUnavailableException(
            'Inference request timed out. Try reducing max_tokens or simplifying your prompt.',
          );
        }

        this.logger.error(`Petals API request failed: ${error.message}`);
        throw new ServiceUnavailableException(
          'Failed to connect to inference service',
        );
      }

      this.logger.error('Unexpected error during Petals API call', error);
      throw new ServiceUnavailableException('Inference service error');
    }
  }

  async *generateStream(request: PetalsGenerateRequest): AsyncGenerator<string> {
    try {
      const response = await this.client.post<any>(
        '/api/v1/generate',
        { ...request, stream: true },
        {
          responseType: 'stream',
        },
      );

      for await (const chunk of response.data) {
        const text = chunk.toString('utf-8');
        const lines = text.split('\n').filter((line: string) => line.trim());

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              return;
            }
            yield data;
          }
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          throw new ServiceUnavailableException(
            'Inference service temporarily unavailable',
          );
        }
      }
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/health', { timeout: 5000 });
      return true;
    } catch (error) {
      return false;
    }
  }
}
