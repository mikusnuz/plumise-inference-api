import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  UnauthorizedException,
  Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { ReportService } from './report.service';

@ApiTags('report')
@Controller('api/v1/report')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  private verifyApiKey(apiKey: string | undefined) {
    const expectedKey = process.env.ORACLE_API_KEY;
    if (!expectedKey) {
      throw new UnauthorizedException('Oracle API key not configured');
    }
    if (!apiKey || apiKey !== expectedKey) {
      throw new UnauthorizedException('Invalid API key');
    }
  }

  @Post()
  @ApiOperation({ summary: 'Receive metrics from agent nodes (Oracle only)' })
  @ApiHeader({ name: 'x-api-key', required: true })
  receiveReport(@Headers('x-api-key') apiKey: string, @Body() report: any) {
    this.verifyApiKey(apiKey);
    this.reportService.receiveReport(report);
    return { status: 'ok' };
  }

  @Get('agents')
  @ApiOperation({ summary: 'Get all agent reports (Oracle only)' })
  @ApiHeader({ name: 'x-api-key', required: true })
  getAllReports(@Headers('x-api-key') apiKey: string) {
    this.verifyApiKey(apiKey);
    return {
      reports: this.reportService.getAllReports(),
    };
  }
}
