import { EventEmitter } from 'events';

// Define types for our agent state
export interface ProcessingStats {
  totalProcessed: number;
  successfulRemovals: number;
  failedRemovals: number;
  averageProcessingTime: number;
}

export interface AgentState {
  id: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
  currentJobId: string | null;
  stats: ProcessingStats;
  lastError: string | null;
  startTime: Date | null;
  lastActivity: Date | null;
}

export interface JobInfo {
  jobId: string;
  fileName: string;
  fileSize: number;
  startTime: Date;
  endTime?: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  resultUrl?: string;
  error?: string;
  processingTime?: number;
}

// Telemetry event types
export interface TelemetryEvent {
  timestamp: Date;
  eventType: string;
  agentId: string;
  data: Record<string, any>;
}

export class AgentStateManager extends EventEmitter {
  private state: AgentState;
  private jobHistory: JobInfo[] = [];
  private telemetryCallbacks: Array<(event: TelemetryEvent) => void> = [];

  constructor(agentId: string) {
    super();
    this.state = {
      id: agentId,
      status: 'idle',
      currentJobId: null,
      stats: {
        totalProcessed: 0,
        successfulRemovals: 0,
        failedRemovals: 0,
        averageProcessingTime: 0
      },
      lastError: null,
      startTime: new Date(),
      lastActivity: new Date()
    };
  }

  // Get current agent state
  getState(): AgentState {
    return { ...this.state };
  }

  // Update agent status
  setStatus(status: AgentState['status']): void {
    const previousStatus = this.state.status;
    this.state.status = status;
    this.state.lastActivity = new Date();
    
    this.emitTelemetry({
      eventType: 'status_change',
      data: { from: previousStatus, to: status }
    });
    
    this.emit('statusChange', { from: previousStatus, to: status });
  }

  // Start processing a new job
  startJob(jobId: string, fileName: string, fileSize: number): void {
    const jobInfo: JobInfo = {
      jobId,
      fileName,
      fileSize,
      startTime: new Date(),
      status: 'processing'
    };
    
    this.jobHistory.push(jobInfo);
    this.state.currentJobId = jobId;
    this.setStatus('processing');
    
    this.emitTelemetry({
      eventType: 'job_start',
      data: { jobId, fileName, fileSize }
    });
    
    this.emit('jobStart', jobInfo);
  }

  // Complete a job successfully
  completeJob(jobId: string, resultUrl: string): void {
    const job = this.findJob(jobId);
    if (!job) return;

    const endTime = new Date();
    const processingTime = endTime.getTime() - job.startTime.getTime();

    job.status = 'completed';
    job.endTime = endTime;
    job.resultUrl = resultUrl;
    job.processingTime = processingTime;

    // Update stats
    this.state.stats.totalProcessed++;
    this.state.stats.successfulRemovals++;
    this.updateAverageProcessingTime(processingTime);
    
    this.state.currentJobId = null;
    this.setStatus('completed');
    
    this.emitTelemetry({
      eventType: 'job_complete',
      data: { jobId, processingTime, resultUrl }
    });
    
    this.emit('jobComplete', { ...job });
  }

  // Fail a job
  failJob(jobId: string, error: string): void {
    const job = this.findJob(jobId);
    if (!job) return;

    const endTime = new Date();
    const processingTime = endTime.getTime() - job.startTime.getTime();

    job.status = 'failed';
    job.endTime = endTime;
    job.error = error;
    job.processingTime = processingTime;

    // Update stats
    this.state.stats.totalProcessed++;
    this.state.stats.failedRemovals++;
    this.updateAverageProcessingTime(processingTime);
    
    this.state.lastError = error;
    this.state.currentJobId = null;
    this.setStatus('error');
    
    this.emitTelemetry({
      eventType: 'job_fail',
      data: { jobId, error, processingTime }
    });
    
    this.emit('jobFail', { ...job });
  }

  // Get job history
  getJobHistory(limit?: number): JobInfo[] {
    const sorted = [...this.jobHistory].sort((a, b) => 
      b.startTime.getTime() - a.startTime.getTime()
    );
    
    return limit ? sorted.slice(0, limit) : sorted;
  }

  // Reset statistics
  resetStats(): void {
    this.state.stats = {
      totalProcessed: 0,
      successfulRemovals: 0,
      failedRemovals: 0,
      averageProcessingTime: 0
    };
    
    this.emitTelemetry({
      eventType: 'stats_reset',
      data: {}
    });
    
    this.emit('statsReset');
  }

  // Register telemetry callback
  addTelemetryCallback(callback: (event: TelemetryEvent) => void): void {
    this.telemetryCallbacks.push(callback);
  }

  // Remove telemetry callback
  removeTelemetryCallback(callback: (event: TelemetryEvent) => void): void {
    const index = this.telemetryCallbacks.indexOf(callback);
    if (index > -1) {
      this.telemetryCallbacks.splice(index, 1);
    }
  }

  // Private methods
  private findJob(jobId: string): JobInfo | undefined {
    return this.jobHistory.find(job => job.jobId === jobId);
  }

  private updateAverageProcessingTime(newTime: number): void {
    const { totalProcessed, averageProcessingTime } = this.state.stats;
    const totalTime = (averageProcessingTime * (totalProcessed - 1)) + newTime;
    this.state.stats.averageProcessingTime = totalTime / totalProcessed;
  }

  private emitTelemetry(event: Omit<TelemetryEvent, 'timestamp' | 'agentId'>): void {
    const telemetryEvent: TelemetryEvent = {
      timestamp: new Date(),
      agentId: this.state.id,
      ...event
    };

    // Call all registered telemetry callbacks
    this.telemetryCallbacks.forEach(callback => {
      try {
        callback(telemetryEvent);
      } catch (error) {
        console.error('Error in telemetry callback:', error);
      }
    });

    // Also emit as a regular event
    this.emit('telemetry', telemetryEvent);
  }
}

// Export a singleton instance for the agent
export const agentState = new AgentStateManager('bg-remover-agent');

export default agentState;