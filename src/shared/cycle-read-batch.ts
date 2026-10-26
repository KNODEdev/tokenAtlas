export const CYCLE_READ_BATCH_MAX = 12;
export interface CycleReadEnvelope { status: number; headers: Array<[string, string]>; body: string }
export interface CycleReadBatch { responses: CycleReadEnvelope[] }
