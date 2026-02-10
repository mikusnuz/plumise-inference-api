import { IsString, IsNumber, IsOptional, IsBoolean, IsArray, ValidateNested, Min, Max, MaxLength, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatMessageDto {
  @ApiProperty({ enum: ['system', 'user', 'assistant'] })
  @IsString()
  @IsIn(['system', 'user', 'assistant'])
  role: 'system' | 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MaxLength(32000)
  content: string;
}

export class InferenceRequestDto {
  @ApiProperty({ example: 'meta-llama/Llama-3.1-8B' })
  @IsString()
  @MaxLength(100)
  model: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32000)
  prompt?: string;

  @ApiPropertyOptional({ type: [ChatMessageDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages?: ChatMessageDto[];

  @ApiProperty({ example: 512 })
  @IsNumber()
  @Min(1)
  @Max(4096)
  max_tokens: number;

  @ApiPropertyOptional({ example: 0.7 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number = 0.7;

  @ApiPropertyOptional({ example: 0.9 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  top_p?: number = 0.9;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  stream?: boolean = false;
}
