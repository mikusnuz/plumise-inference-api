import { Injectable, Logger } from '@nestjs/common';
import { ModelService } from '../model/model.service';

export interface AgentReport {
  agentId: string;
  address: string;
  models: string[];
  performance: {
    requests: number;
    avgLatency: number;
    errors: number;
  };
  timestamp: Date;
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  private readonly reports = new Map<string, AgentReport>();

  constructor(private readonly modelService: ModelService) {}

  receiveReport(report: AgentReport) {
    this.reports.set(report.agentId, report);
    this.logger.log(`Received report from agent ${report.agentId}: ${report.models.join(', ')}`);

    for (const modelId of report.models) {
      const activeNodes = Array.from(this.reports.values()).filter((r) =>
        r.models.includes(modelId),
      ).length;

      this.modelService.updateModelStatus(modelId, activeNodes);
    }
  }

  getAllReports(): AgentReport[] {
    return Array.from(this.reports.values());
  }

  getAgentReport(agentId: string): AgentReport | undefined {
    return this.reports.get(agentId);
  }

  cleanupStaleReports() {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [agentId, report] of this.reports.entries()) {
      if (now - report.timestamp.getTime() > staleThreshold) {
        this.logger.warn(`Removing stale report from agent ${agentId}`);
        this.reports.delete(agentId);
      }
    }

    const activeModels = new Set<string>();
    for (const report of this.reports.values()) {
      for (const modelId of report.models) {
        activeModels.add(modelId);
      }
    }

    for (const modelId of activeModels) {
      const activeNodes = Array.from(this.reports.values()).filter((r) =>
        r.models.includes(modelId),
      ).length;

      this.modelService.updateModelStatus(modelId, activeNodes);
    }
  }
}
