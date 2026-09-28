export type CriterionOrigin = 'explicit' | 'inferred';
export type CriterionStatus = 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' | 'MISSING' | 'NOT_APPLICABLE';

export interface Criterion {
  id: string;
  text: string;
  origin: CriterionOrigin;
  sourceId: string;
  notApplicable?: boolean;
}

export interface RequirementSource {
  id: string;
  kind: 'markdown' | 'github-issue' | 'github-pull-request' | 'inline';
  title: string;
  url?: string;
  text: string;
}

export interface FileEvidence {
  path: string;
  lines?: string;
  relation: 'implementation' | 'test';
  method: 'explicit-id' | 'lexical' | 'model';
  note: string;
}

export interface CommandExecution {
  id: string;
  revision: string;
  command: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputTruncated: boolean;
  termination?: 'exit' | 'timeout' | 'output-limit' | 'start-failed' | 'unavailable';
  durationMs: number;
  output: string;
  workspace: string;
}

export type ExecutionMode = 'isolated' | 'trusted' | 'no-exec';

export interface CriterionResult extends Criterion {
  status: CriterionStatus;
  implementationEvidence: FileEvidence[];
  testEvidence: FileEvidence[];
  executions: string[];
  reason: string;
}

export interface GeneratedTestRecord {
  criterionId: string;
  fileName: string;
  source: string;
  rationale: string;
  executions: string[];
}

export interface TraceReport {
  schemaVersion: 1;
  tool: { name: 'CriteriaTrace'; version: string };
  repository: { root: string; remote?: string };
  base: string;
  head: string;
  createdAt: string;
  executionPolicy?: {
    mode: ExecutionMode;
    network: 'disabled' | 'enabled' | 'host-policy' | 'none';
  };
  sources: RequirementSource[];
  criteria: CriterionResult[];
  executions: CommandExecution[];
  generatedTests: GeneratedTestRecord[];
  semanticProvider?: string;
  summary: Record<CriterionStatus, number>;
  limitations: string[];
}

export interface CriteriaTraceConfig {
  version: 1;
  provider: { name: 'openai' | 'mock'; model: string };
  verification: { base: string; counterfactual: boolean; generatedTests: boolean };
  commands: {
    setup?: string[] | undefined;
    test?: string[] | undefined;
    generatedTest?: string[] | undefined;
  };
  limits: {
    commandTimeoutSeconds: number;
    maxCommandOutputBytes: number;
    maxContextBytes: number;
    maxFiles: number;
    maxFileBytes: number;
    maxGeneratedTests: number;
  };
  policy: { failOn: CriterionStatus[] };
}
