import type {
  CommandExecution,
  CriteriaTraceConfig,
  Criterion,
  CriterionResult,
  CriterionStatus,
  FileEvidence,
  GeneratedTestRecord,
  RequirementSource,
  TraceReport,
  ExecutionMode,
} from './types.js';
import { loadConfig } from './config.js';
import { maxCriteria, parseCriteria } from './criteria.js';
import {
  changedFiles,
  fileAt,
  git,
  remoteUrl,
  repositoryRoot,
  revision,
  trackedFiles,
} from './git.js';
import {
  isSourcePath,
  isTestPath,
  hasExplicitCriterionReference,
  lexicalEvidence,
  type CandidateFile,
  validateModelPaths,
} from './mapper.js';
import {
  createProvider,
  type ProposedTest,
  type SemanticMapping,
  type SemanticProvider,
} from './provider.js';
import { detectFramework, executeRevision, type FrameworkInfo } from './execute.js';
import { redactSensitiveData, redactSensitiveText } from './security.js';

export interface VerifyOptions {
  root?: string;
  sources: RequirementSource[];
  base?: string;
  head?: string;
  execute?: boolean;
  apiKey?: string;
  semanticProvider?: SemanticProvider;
  config?: CriteriaTraceConfig;
  executionMode?: ExecutionMode;
  allowNetwork?: boolean;
}

interface Inspection {
  report: TraceReport;
  config: CriteriaTraceConfig;
  framework: FrameworkInfo;
  candidates: CandidateFile[];
  mappings: Map<string, SemanticMapping>;
  criteria: Criterion[];
  provider?: SemanticProvider;
}

const maxSourceBytes = 1_048_576;

export async function inspect(options: VerifyOptions): Promise<TraceReport> {
  return redactSensitiveData((await analyze(options, false)).report);
}

export async function verify(options: VerifyOptions): Promise<TraceReport> {
  const analysis = await analyze(options, true);
  const { report, config, framework, candidates, mappings, criteria } = analysis;
  const baseRef = options.base ?? config.verification.base;
  const headRef = options.head ?? 'HEAD';
  const generatedTests: GeneratedTestRecord[] = [];
  const limitations = report.limitations;
  const executionMode = options.executionMode ?? 'isolated';
  report.executionPolicy = {
    mode: executionMode,
    network:
      executionMode === 'isolated'
        ? options.allowNetwork
          ? 'enabled'
          : 'disabled'
        : executionMode === 'trusted'
          ? 'host-policy'
          : 'none',
  };
  if (options.allowNetwork && executionMode !== 'isolated')
    throw new Error('--allow-network applies only to isolated execution.');
  if (executionMode === 'no-exec') {
    limitations.push(
      'No repository command ran; static candidate links do not establish a passing test.',
    );
    if (config.verification.counterfactual)
      report.executions.push(
        unavailableExecution('base-test', report.base, 'Execution disabled by --no-exec.'),
      );
    report.executions.push(
      unavailableExecution('head-test', report.head, 'Execution disabled by --no-exec.'),
    );
    report.criteria = report.criteria.map((result) =>
      finalizeResult(result, report.executions, []),
    );
    report.summary = summarize(report.criteria);
    return redactSensitiveData(report);
  }

  if (framework.framework === 'unsupported' && !config.commands.test) {
    limitations.push(framework.reason);
    if (config.verification.counterfactual) {
      report.executions.push(unavailableExecution('base-test', report.base, framework.reason));
    }
    report.executions.push(unavailableExecution('head-test', report.head, framework.reason));
  } else {
    let baseExecutions: CommandExecution[] = [];
    if (config.verification.counterfactual) {
      try {
        baseExecutions = await executeRevision({
          root: report.repository.root,
          ref: baseRef,
          revisionLabel: 'base',
          config,
          framework,
          executionMode,
          allowNetwork: options.allowNetwork,
        });
      } catch (error) {
        limitations.push(`Base execution could not run: ${safeError(error)}`);
        baseExecutions = [
          unavailableExecution('base-test', report.base, 'Base execution could not run.'),
        ];
      }
    }
    let headExecutions: CommandExecution[];
    try {
      headExecutions = await executeRevision({
        root: report.repository.root,
        ref: headRef,
        revisionLabel: 'head',
        config,
        framework,
        executionMode,
        allowNetwork: options.allowNetwork,
      });
    } catch (error) {
      limitations.push(`Head execution could not run: ${safeError(error)}`);
      headExecutions = [
        unavailableExecution('head-test', report.head, 'Head execution could not run.'),
      ];
    }
    report.executions.push(...baseExecutions, ...headExecutions);
  }
  if (report.executions.some((execution) => execution.termination === 'unavailable')) {
    limitations.push(
      'One or more repository commands were unavailable; no host fallback was used.',
    );
  }

  if (config.verification.generatedTests) {
    const provider = analysis.provider;
    if (!provider) {
      limitations.push(
        'Generated tests require an available semantic provider and OPENAI_API_KEY; none were run.',
      );
    } else {
      const uncovered = criteria.filter(
        (criterion) =>
          !criterion.notApplicable && (mappings.get(criterion.id)?.testPaths.length ?? 0) === 0,
      );
      try {
        const proposals = await provider.generate(
          uncovered,
          candidates,
          config.limits.maxGeneratedTests,
          config.limits.maxContextBytes,
        );
        const accepted = validateGeneratedTests(proposals, uncovered, framework, config);
        if (accepted.length === 0 && provider.name === 'mock') {
          limitations.push('The deterministic mock provider does not generate test source.');
        }
        for (const proposal of accepted) {
          const baseGenerated: CommandExecution[] = config.verification.counterfactual
            ? await executeRevision({
                root: report.repository.root,
                ref: baseRef,
                revisionLabel: `base-${safeSlug(proposal.criterionId)}`,
                config,
                framework,
                executionMode,
                allowNetwork: options.allowNetwork,
                generated: { fileName: proposal.fileName, source: proposal.source },
                generatedTarget: true,
              })
            : [];
          const headGenerated = await executeRevision({
            root: report.repository.root,
            ref: headRef,
            revisionLabel: `head-${safeSlug(proposal.criterionId)}`,
            config,
            framework,
            executionMode,
            allowNetwork: options.allowNetwork,
            generated: { fileName: proposal.fileName, source: proposal.source },
            generatedTarget: true,
          });
          const executions = [...baseGenerated, ...headGenerated];
          report.executions.push(...executions);
          generatedTests.push({
            criterionId: proposal.criterionId,
            fileName: proposal.fileName,
            source: proposal.source,
            rationale: proposal.rationale.slice(0, 500),
            executions: executions.map((execution) => execution.id),
          });
        }
      } catch {
        limitations.push(
          'OpenAI generated-test request or output validation failed; no generated test was run.',
        );
      }
    }
  }

  report.generatedTests = generatedTests;
  report.criteria = report.criteria.map((result) =>
    finalizeResult(result, report.executions, generatedTests),
  );
  report.summary = summarize(report.criteria);
  return redactSensitiveData(report);
}

function unavailableExecution(id: string, revision: string, message: string): CommandExecution {
  return {
    id,
    revision,
    command: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    termination: 'unavailable',
    durationMs: 0,
    output: message,
    workspace: 'No command ran; no temporary archive was retained.',
  };
}

async function analyze(options: VerifyOptions, executeMode: boolean): Promise<Inspection> {
  if (options.sources.length === 0)
    throw new Error('Provide a Markdown specification, GitHub issue, or inline task.');
  const sourceBytes = options.sources.reduce(
    (total, source) =>
      total +
      Buffer.byteLength(source.id) +
      Buffer.byteLength(source.title) +
      Buffer.byteLength(source.url ?? '') +
      Buffer.byteLength(source.text),
    0,
  );
  if (sourceBytes > maxSourceBytes) {
    throw new Error(`Requirement sources exceed the ${maxSourceBytes}-byte limit.`);
  }
  const start = options.root ?? process.cwd();
  const root = repositoryRoot(start);
  const config = options.config ?? (await loadConfig(root));
  const baseRef = options.base ?? config.verification.base;
  const headRef = options.head ?? 'HEAD';
  const baseSha = revision(root, baseRef);
  const headSha = revision(root, headRef);
  const changed = new Set(changedFiles(root, baseSha, headSha));
  const allPaths = trackedFiles(root, headSha);
  const limitations: string[] = [];
  const candidatePaths = [
    ...new Set([
      ...allPaths.filter((path) => changed.has(path) && isSourcePath(path)),
      ...allPaths.filter(isTestPath),
    ]),
  ];
  const boundedPaths = candidatePaths.slice(0, config.limits.maxFiles);
  if (candidatePaths.length > boundedPaths.length) {
    limitations.push(
      `Candidate file scan limited to ${boundedPaths.length} files; changed source files and repository tests are prioritized.`,
    );
  }
  if (git(root, ['status', '--porcelain'])) {
    limitations.push(
      `Uncommitted working tree changes were not included; analysis compares ${baseSha.slice(0, 12)} to ${headSha.slice(0, 12)}.`,
    );
  }

  const candidates: CandidateFile[] = [];
  let contextBytes = 0;
  for (const path of boundedPaths) {
    const test = isTestPath(path);
    const implementation = changed.has(path) && isSourcePath(path);
    if (!test && !implementation) continue;
    const content = fileAt(root, headSha, path);
    if (content === undefined) continue;
    const clipped = redactSensitiveText(
      Buffer.from(content).subarray(0, config.limits.maxFileBytes).toString('utf8'),
    );
    const byteSize = Buffer.byteLength(clipped);
    if (contextBytes + byteSize > config.limits.maxContextBytes * 4) {
      limitations.push('Candidate source collection reached its configured context budget.');
      break;
    }
    contextBytes += byteSize;
    candidates.push({ path, content: clipped, changed: changed.has(path), test });
  }

  const sources = options.sources.map((source) => ({
    ...source,
    title: redactSensitiveText(source.title),
    ...(source.url ? { url: redactSensitiveText(source.url) } : {}),
    text: redactSensitiveText(source.text),
  }));
  let criteria = sources.flatMap(parseCriteria);
  if (criteria.length > maxCriteria) throw new Error(`Too many criteria; limit is ${maxCriteria}.`);
  const provider =
    options.semanticProvider ??
    createProvider(config, options.apiKey ?? process.env.OPENAI_API_KEY);
  if (provider && criteria.some((item) => item.id.startsWith('REQ-'))) {
    const expanded: Criterion[] = [];
    for (const source of sources) {
      const sourceCriteria = parseCriteria(source);
      if (sourceCriteria.length === 1 && sourceCriteria[0]?.id.startsWith('REQ-')) {
        try {
          const decomposition = await provider.decompose(
            sourceCriteria[0].text,
            config.limits.maxContextBytes,
          );
          if (decomposition.length > 0) {
            expanded.push(
              ...decomposition.map((item) => ({
                id: normalizeCriterionId(item.id),
                text: item.text.trim().slice(0, 1500),
                origin: 'inferred' as const,
                sourceId: source.id,
              })),
            );
            continue;
          }
        } catch {
          limitations.push(
            `Natural-language decomposition failed for source ${source.title}; the full source remains one explicit requirement.`,
          );
        }
      }
      expanded.push(...sourceCriteria);
    }
    criteria = expanded;
  }
  if (criteria.length > maxCriteria) throw new Error(`Too many criteria; limit is ${maxCriteria}.`);
  criteria = uniqueCriterionIds(criteria);
  if (criteria.length === 0)
    throw new Error('No non-empty acceptance criteria were found in the supplied sources.');

  let semanticMappings: SemanticMapping[] = [];
  if (provider) {
    try {
      semanticMappings = await provider.map(criteria, candidates, config.limits.maxContextBytes);
    } catch {
      limitations.push(
        'Semantic mapping was unavailable; deterministic lexical candidate matching was used.',
      );
    }
  } else {
    limitations.push(
      'OPENAI_API_KEY is not set; source decomposition and semantic mapping were not used. Candidate links use lexical matching.',
    );
  }

  const implementationPaths = new Set(
    candidates.filter((file) => !file.test && file.changed).map((file) => file.path),
  );
  const testPaths = new Set(candidates.filter((file) => file.test).map((file) => file.path));
  const candidateByPath = new Map(candidates.map((file) => [file.path, file]));
  const mappings = new Map<string, SemanticMapping>();
  const results: CriterionResult[] = criteria.map((criterion) => {
    const model = semanticMappings.find((mapping) => mapping.criterionId === criterion.id);
    const modelImplementations = validateModelPaths(
      model?.implementationPaths ?? [],
      implementationPaths,
    );
    const modelTests = validateModelPaths(model?.testPaths ?? [], testPaths);
    const lexical = lexicalEvidence(criterion, candidates);
    const implementationEvidence = lexical.filter((item) => item.relation === 'implementation');
    const testEvidence = lexical.filter((item) => item.relation === 'test');
    for (const path of modelImplementations) {
      const file = candidateByPath.get(path)!;
      if (!implementationEvidence.some((item) => item.path === path)) {
        implementationEvidence.push(
          modelEvidence(path, file.content, criterion, 'implementation', model?.explanation),
        );
      }
    }
    for (const path of modelTests) {
      const file = candidateByPath.get(path)!;
      if (!testEvidence.some((item) => item.path === path)) {
        testEvidence.push(modelEvidence(path, file.content, criterion, 'test', model?.explanation));
      }
    }
    const selected = {
      criterionId: criterion.id,
      implementationPaths: [
        ...new Set([...modelImplementations, ...implementationEvidence.map((item) => item.path)]),
      ],
      testPaths: [...new Set([...modelTests, ...testEvidence.map((item) => item.path)])],
      explanation: model?.explanation ?? 'Deterministic lexical candidate matching.',
    };
    mappings.set(criterion.id, selected);
    const status: CriterionStatus = criterion.notApplicable
      ? 'NOT_APPLICABLE'
      : implementationEvidence.length === 0
        ? 'MISSING'
        : testEvidence.length === 0
          ? 'UNVERIFIED'
          : 'PARTIAL';
    return {
      ...criterion,
      status,
      implementationEvidence,
      testEvidence,
      executions: [],
      reason: criterion.notApplicable
        ? 'The source explicitly marks this criterion [N/A]; a human should review whether that label is appropriate.'
        : executeMode
          ? 'No executable result has been evaluated yet.'
          : testEvidence.length > 0
            ? 'Candidate implementation and test links found; inspect these paths. No command was executed.'
            : implementationEvidence.length > 0
              ? 'Candidate implementation found, but no related test evidence was found.'
              : 'No changed implementation surface was matched to this criterion.',
    };
  });

  const packageJson = fileAt(root, headSha, 'package.json');
  const pythonConfig =
    fileAt(root, headSha, 'pyproject.toml') ?? fileAt(root, headSha, 'setup.cfg');
  const framework = detectFramework(packageJson, allPaths, pythonConfig);
  const report: TraceReport = {
    schemaVersion: 1,
    tool: { name: 'CriteriaTrace', version: '0.1.0' },
    repository: { root, ...(remoteUrl(root) ? { remote: remoteUrl(root)! } : {}) },
    base: baseSha,
    head: headSha,
    createdAt: new Date().toISOString(),
    ...(!executeMode
      ? { executionPolicy: { mode: 'no-exec' as const, network: 'none' as const } }
      : {}),
    sources,
    criteria: results,
    executions: [],
    generatedTests: [],
    ...(provider
      ? {
          semanticProvider:
            provider.name === 'openai'
              ? `OpenAI (${config.provider.model})`
              : 'mock lexical provider',
        }
      : {}),
    summary: summarize(results),
    limitations: [
      ...limitations,
      ...(executeMode ? [] : ['Inspect mode does not execute repository code.']),
    ],
  };
  return {
    report,
    config,
    framework,
    candidates,
    mappings,
    criteria,
    ...(provider ? { provider } : {}),
  };
}

function modelEvidence(
  path: string,
  content: string,
  criterion: Criterion,
  relation: 'implementation' | 'test',
  explanation = '',
): FileEvidence {
  const hasId = hasExplicitCriterionReference(path, content, criterion.id, relation);
  const method = hasId ? 'explicit-id' : 'model';
  const note = hasId
    ? `Contains ${criterion.id}; model also selected this candidate.`
    : `Model-selected candidate. ${explanation.slice(0, 240)}`;
  return { path, relation, method, note };
}

function finalizeResult(
  result: CriterionResult,
  executions: CommandExecution[],
  generatedTests: GeneratedTestRecord[],
): CriterionResult {
  if (result.notApplicable) {
    return {
      ...result,
      status: 'NOT_APPLICABLE',
      executions: [],
      reason:
        'The source explicitly marks this criterion [N/A]; a human should review whether that label is appropriate.',
    };
  }
  const generated = generatedTests.filter((item) => item.criterionId === result.id);
  const generatedEvidence: FileEvidence[] = generated.map((item) => ({
    path: item.fileName,
    relation: 'test',
    method: 'model',
    note: `Generated for ${result.id}; inspect and treat as advisory.`,
  }));
  const testEvidence = [...result.testEvidence, ...generatedEvidence];
  const attached = new Set<string>();
  let status: CriterionStatus;
  let reason: string;

  if (result.implementationEvidence.length > 0) {
    if (testEvidence.length === 0) {
      status = 'UNVERIFIED';
      reason =
        'Related implementation candidate found, but no executable test evidence was identified.';
    } else {
      const matchingGenerated = generated.find((item) => item.criterionId === result.id);
      const generatedHead = matchingGenerated?.executions
        .map((id) => executions.find((execution) => execution.id === id))
        .find((execution) => execution?.id.startsWith('head-'));
      const regularHead = executions.find((execution) => execution.id === 'head-test');
      const head = generatedHead ?? regularHead;
      if (head) attached.add(head.id);
      const baseId =
        matchingGenerated?.executions.find((id) => id.startsWith('base-')) ?? 'base-test';
      const base = executions.find((execution) => execution.id === baseId);
      if (base) attached.add(base.id);
      if (!head || head.exitCode !== 0 || head.timedOut) {
        status = 'UNVERIFIED';
        reason = head?.timedOut
          ? 'The associated test command timed out; execution did not pass.'
          : head?.exitCode === null
            ? 'The associated test command could not be started or produced no exit code.'
            : 'The associated test command did not pass on head.';
      } else {
        status = 'PARTIAL';
        reason =
          base && base.exitCode !== null && base.exitCode !== 0
            ? `The repository-controlled base command exited ${base.exitCode} and head exited 0. This is candidate evidence, not independent verification.`
            : 'The repository-controlled head command exited 0. Its output and exit status cannot independently verify the criterion.';
      }
    }
  } else {
    status = 'MISSING';
    reason = 'No changed implementation candidate was found for this criterion.';
  }
  for (const generatedTest of generated)
    for (const id of generatedTest.executions) attached.add(id);
  return {
    ...result,
    status,
    testEvidence,
    executions: [...attached],
    reason,
  };
}

function validateGeneratedTests(
  proposals: ProposedTest[],
  criteria: Criterion[],
  framework: FrameworkInfo,
  config: CriteriaTraceConfig,
): ProposedTest[] {
  if (config.limits.maxGeneratedTests === 0) return [];
  const known = new Set(criteria.map((criterion) => criterion.id));
  const extension = framework.framework === 'pytest' ? 'py' : 'test.mjs';
  const accepted: ProposedTest[] = [];
  for (const proposal of proposals) {
    if (!known.has(proposal.criterionId) || proposal.source.includes('\0')) continue;
    if (Buffer.byteLength(proposal.source) > config.limits.maxFileBytes) continue;
    const id = safeSlug(proposal.criterionId);
    const fileName = `__criteriatrace__/test_${id}.${extension}`;
    accepted.push({ ...proposal, fileName, rationale: proposal.rationale.slice(0, 500) });
    if (accepted.length >= config.limits.maxGeneratedTests) break;
  }
  return accepted;
}

function uniqueCriterionIds(criteria: Criterion[]): Criterion[] {
  const seen = new Map<string, number>();
  return criteria.map((criterion) => {
    const count = (seen.get(criterion.id) ?? 0) + 1;
    seen.set(criterion.id, count);
    return count === 1 ? criterion : { ...criterion, id: `${criterion.id}-${count}` };
  });
}

function normalizeCriterionId(id: string): string {
  const safe = id
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return safe || 'AC-INFERRED';
}

function safeSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .slice(0, 48) || 'criterion'
  );
}

function summarize(results: CriterionResult[]): TraceReport['summary'] {
  const summary: TraceReport['summary'] = {
    VERIFIED: 0,
    PARTIAL: 0,
    UNVERIFIED: 0,
    MISSING: 0,
    NOT_APPLICABLE: 0,
  };
  for (const result of results) summary[result.status] += 1;
  return summary;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).slice(0, 300);
}
