import { Controller, Get, Param, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ModelService } from './model.service';
import { WalletAuthGuard } from '../auth/auth.guard';

@ApiTags('models')
@Controller('api/v1/models')
export class ModelController {
  constructor(private readonly modelService: ModelService) {}

  @Get()
  @ApiOperation({ summary: 'List all available models' })
  listModels() {
    return {
      models: this.modelService.getAllModels(),
    };
  }

  @Get(':id')
  @UseGuards(WalletAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get model details' })
  getModel(@Param('id') id: string) {
    const model = this.modelService.getModel(id);

    if (!model) {
      throw new NotFoundException(`Model ${id} not found`);
    }

    return model;
  }
}
