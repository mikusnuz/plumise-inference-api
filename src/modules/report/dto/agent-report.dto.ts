import { IsString, IsNotEmpty, IsArray, IsNumber, IsObject, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class PerformanceDto {
  @ApiProperty()
  @IsNumber()
  @Min(0)
  requests: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  avgLatency: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  errors: number;
}

export class AgentReportDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  agentId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  models: string[];

  @ApiProperty({ type: PerformanceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PerformanceDto)
  performance: PerformanceDto;

  @ApiProperty()
  @IsNumber()
  timestamp: number;
}
