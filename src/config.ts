import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { CriteriaTraceConfig, CriterionStatus } from './types.js';

const statuses = ['VERIFIED', 'PARTIAL', 'UNVERIFIED', 'MISSING', 'NOT_APPLICABLE'] as const;
const maxConfigBytes = 1_048_576;
const command = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine((part) => !part.includes('\0'), 'must not contain NUL'),
  )
  .min(1)
  .max(128)
  .superRefine((parts, context) => {
    if (parts.reduce((total, part) => total + Buffer.byteLength(part), 0) > 32_768) {
      context.addIssue({
        code: 'custom',
        message: 'combined command arguments exceed 32768 bytes',
      });
    }
  });

const configSchema = z
  .object({
    version: z.literal(1),
    provider: z
      .object({
        name: z.enum(['openai', 'mock']).default('openai'),
        model: z.string().min(1).max(256).default('gpt-5.5'),
      })
      .strict()
      .default({ name: 'openai', model: 'gpt-5.5' }),
    verification: z
      .object({
        base: z.string().min(1).max(4096).default('origin/HEAD'),
        counterfactual: z.boolean().default(true),
        generatedTests: z.boolean().default(false),
      })
      .strict()
      .default({ base: 'origin/HEAD', counterfactual: true, generatedTests: false }),
    commands: z.preprocess(
      (value) => (value === null ? {} : value),
      z
        .object({
          setup: command.optional(),
          test: command.optional(),
          generatedTest: command.optional(),
        })
        .strict()
        .default({}),
    ),
    limits: z
      .object({
        commandTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
        maxCommandOutputBytes: z.number().int().min(1024).max(5_000_000).default(100_000),
        maxContextBytes: z.number().int().min(1024).max(1_000_000).default(80_000),
        maxFiles: z.number().int().min(1).max(5000).default(500),
        maxFileBytes: z.number().int().min(256).max(2_000_000).default(50_000),
        maxGeneratedTests: z.number().int().min(0).max(20).default(3),
      })
      .strict()
      .default({
        commandTimeoutSeconds: 300,
        maxCommandOutputBytes: 100_000,
        maxContextBytes: 80_000,
        maxFiles: 500,
        maxFileBytes: 50_000,
        maxGeneratedTests: 3,
      }),
    policy: z
      .object({ failOn: z.array(z.enum(statuses)).default(['MISSING']) })
      .strict()
      .default({ failOn: ['MISSING'] }),
  })
  .strict();

export const starterConfig = `# CriteriaTrace repository configuration (schema version 1)
version: 1

provider:
  name: openai
  model: gpt-5.5

verification:
  base: origin/HEAD
  counterfactual: true
  generatedTests: false

# Commands are argument arrays. CriteriaTrace does not invoke a shell.
# Configure setup only if installing dependencies is acceptable for this repository.
commands:
  # setup: [npm, ci, --ignore-scripts]
  # test: [npm, test]
  # generatedTest: [node, node_modules/vitest/vitest.mjs, run, "{testFile}"]

limits:
  commandTimeoutSeconds: 300
  maxCommandOutputBytes: 100000
  maxContextBytes: 80000
  maxFiles: 500
  maxFileBytes: 50000
  maxGeneratedTests: 3

policy:
  failOn: [MISSING]
`;

export async function initConfig(root: string, force = false): Promise<string> {
  const path = join(root, '.criteriatrace.yml');
  if (!force) {
    await writeFile(path, starterConfig, { flag: 'wx' });
    return path;
  }
  const temporary = join(root, `.criteriatrace-init-${randomUUID()}`);
  try {
    await writeFile(temporary, starterConfig, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadConfig(root: string): Promise<CriteriaTraceConfig> {
  const path = join(root, '.criteriatrace.yml');
  let source: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('.criteriatrace.yml must be a regular file.');
    if (info.size > maxConfigBytes) {
      throw new Error(`.criteriatrace.yml exceeds the ${maxConfigBytes}-byte limit.`);
    }
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return configSchema.parse({ version: 1 });
    throw error;
  }
  return parseConfigText(source);
}

export function parseConfigText(source: string): CriteriaTraceConfig {
  if (Buffer.byteLength(source) > maxConfigBytes) {
    throw new Error(
      `Invalid .criteriatrace.yml: configuration exceeds the ${maxConfigBytes}-byte limit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(source, { uniqueKeys: true });
  } catch (error) {
    throw new Error(`Invalid .criteriatrace.yml: ${(error as Error).message}`, { cause: error });
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.') || '(root)';
        return issue.code === 'unrecognized_keys'
          ? `${path}: unrecognized key(s): ${issue.keys.join(', ')}`
          : `${path}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid .criteriatrace.yml:\n${details}`);
  }
  return result.data;
}

export function failsPolicy(
  statusesToCheck: CriterionStatus[],
  failOn: CriterionStatus[],
): boolean {
  return statusesToCheck.some((status) => failOn.includes(status));
}
