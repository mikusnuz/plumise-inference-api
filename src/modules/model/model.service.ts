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
        id: 'qwen/qwen3-32b',
        name: 'Qwen3 32B',
        description: 'Qwen3 32B dense model (32B params)',
        max_tokens: 4096,
        tier: 'free',
        nodes: 0,
        status: 'available',
        totalLayers: 64,
      },
      {
        id: 'qwen/qwen3.5-397b-a17b',
        name: 'Qwen3.5 397B',
        description: 'Qwen3.5 397B MoE model (397B params, 17B active)',
        max_tokens: 4096,
        tier: 'pro',
        nodes: 0,
        status: 'available',
        totalLayers: 96,
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
