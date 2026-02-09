import { ApiProperty } from '@nestjs/swagger';

export class InferenceChoiceDto {
  @ApiProperty()
  text?: string;

  @ApiProperty()
  message?: {
    role: string;
    content: string;
  };

  @ApiProperty()
  finish_reason: 'stop' | 'length';
}

export class InferenceUsageDto {
  @ApiProperty()
  prompt_tokens: number;

  @ApiProperty()
  completion_tokens: number;

  @ApiProperty()
  total_tokens: number;
}

export class InferenceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  model: string;

  @ApiProperty({ type: [InferenceChoiceDto] })
  choices: InferenceChoiceDto[];

  @ApiProperty({ type: InferenceUsageDto })
  usage: InferenceUsageDto;
}
