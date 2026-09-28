import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { requirePullRequestEvent } from '../src/action/event.js';

describe('GitHub Action metadata', () => {
  it('rejects other PR-bearing events before processing a pull request payload', () => {
    expect(() => requirePullRequestEvent('pull_request')).not.toThrow();
    for (const event of [
      'pull_request_target',
      'pull_request_review',
      'pull_request_review_comment',
    ]) {
      expect(() => requirePullRequestEvent(event)).toThrow('requires a pull_request event');
    }
  });

  it('uses the documented Node 24 runtime and a checked-in bundle path', async () => {
    const metadata = parseYaml(await readFile(join(process.cwd(), 'action.yml'), 'utf8')) as {
      runs: { using: string; main: string };
      inputs: Record<string, { required?: boolean; default?: string }>;
    };
    expect(metadata.runs).toEqual({ using: 'node24', main: 'action/dist/index.js' });
    expect(metadata.inputs.comment?.default).toBe('false');
    expect(metadata.inputs['openai-api-key']?.required).toBe(false);
  });
});
