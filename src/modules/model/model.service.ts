import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModelInfo } from '../../common/interfaces';

@Injectable()
export class ModelService implements OnModuleInit {
  private readonly logger = new Logger(ModelService.name);
  private readonly models = new Map<string, ModelInfo>();

  onModuleInit() {
    this.initializeModels();
  }

  private initializeModels() {
    const modelsList: ModelInfo[] = [
      {
        id: 'openai/gpt-oss-20b',
        name: 'GPT-OSS 20B',
        description: 'OpenAI GPT-OSS 20B MoE model (21B params, 3.6B active)',
        max_tokens: 4096,
        tier: 'free',
        nodes: 2,
        status: 'available',
        totalLayers: 24,
      },
      {
        id: 'bigscience/bloom-560m',
        name: 'BLOOM 560M',
        description: 'BigScience BLOOM 560M parameter model (for development)',
        max_tokens: 2048,
        tier: 'free',
        nodes: 2,
        status: 'available',
        totalLayers: 24,
      },
    ];

    for (const model of modelsList) {
      this.models.set(model.id, model);
    }

    this.logger.log(`Initialized ${this.models.size} models`);
  }

  getAllModels(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  getModel(modelId: string): ModelInfo | undefined {
    return this.models.get(modelId);
  }

  updateModelStatus(modelId: string, nodes: number) {
    const model = this.models.get(modelId);
    if (model) {
      model.nodes = nodes;
      model.status = nodes > 0 ? 'available' : 'offline';
      this.logger.log(`Updated ${modelId}: ${nodes} nodes, status=${model.status}`);
    }
  }

  isModelAvailable(modelId: string): boolean {
    const model = this.models.get(modelId);
    return model ? model.status === 'available' : false;
  }

  getAvailableModelsForTier(tier: 'free' | 'pro'): ModelInfo[] {
    return Array.from(this.models.values()).filter(
      (model) => model.status === 'available' && (tier === 'pro' || model.tier === 'free'),
    );
  }
}
