import * as core from '@actions/core';
import * as github from '@actions/github';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchIssueSource, githubApiBase } from '../github.js';
import { git, remoteUrl } from '../git.js';
import { parseConfigText } from '../config.js';
import { toJson, toMarkdown } from '../report.js';
import { redactSensitiveText } from '../security.js';
import { verify } from '../verify.js';
import type { RequirementSource } from '../types.js';
import { requirePullRequestEvent } from './event.js';

const reportMarker = '<!-- criteriatrace-report -->';

async function main(): Promise<void> {
  requirePullRequestEvent(github.context.eventName);
  const payload = github.context.payload as {
    pull_request?: {
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      base: { sha: string; repo: { full_name: string } };
      head: { sha: string; repo: { full_name: string } };
    };
  };
  const pull = payload.pull_request;
  if (!pull) throw new Error('CriteriaTrace action requires a pull_request event.');
  if (!/^[0-9a-f]{40}$/i.test(pull.base.sha) || !/^[0-9a-f]{40}$/i.test(pull.head.sha)) {
    throw new Error('GitHub did not provide valid base and head commit IDs.');
  }

  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  const isFork = pull.base.repo.full_name.toLowerCase() !== pull.head.repo.full_name.toLowerCase();
  ensureCommit(root, 'head', pull.head.sha);
  ensureCommit(root, 'base', pull.base.sha);
  const actualHead = git(root, ['rev-parse', '--verify', `${pull.head.sha}^{commit}`]);
  if (actualHead.toLowerCase() !== pull.head.sha.toLowerCase())
    throw new Error('Fetched pull request head does not match the event payload.');

  const headConfig = gitShow(root, `${pull.head.sha}:.criteriatrace.yml`);
  const config = parseConfigText(headConfig ?? 'version: 1\n');
  const sources: RequirementSource[] = [
    {
      id: `github-pr-${pull.number}`,
      kind: 'github-pull-request',
      title: `#${pull.number} ${pull.title}`,
      url: pull.html_url,
      text: `# ${pull.title}\n\n${pull.body ?? ''}`,
    },
  ];
  const remote = remoteUrl(root);
  const relatedIssues = [
    ...new Set((pull.body ?? '').match(/#(\d+)/g)?.map((ref) => Number(ref.slice(1))) ?? []),
  ]
    .filter((number) => Number.isSafeInteger(number) && number > 0 && number !== pull.number)
    .slice(0, 3);
  if (remote) {
    for (const issue of relatedIssues) {
      try {
        sources.push(await fetchIssueSource(remote, issue, token || undefined));
      } catch (error) {
        core.warning(
          `Could not read referenced issue #${issue}: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
  }

  const suppliedKey = core.getInput('openai-api-key');
  const report = await verify({
    root,
    sources,
    base: pull.base.sha,
    head: pull.head.sha,
    config,
    // Fork PRs never receive an OpenAI key, even if a workflow accidentally supplies one.
    apiKey: isFork ? '' : suppliedKey || process.env.OPENAI_API_KEY || '',
  });
  if (isFork && (suppliedKey || process.env.OPENAI_API_KEY)) {
    report.limitations.push(
      'OpenAI provider was disabled because this pull request comes from a fork.',
    );
  }

  const markdown = toMarkdown(report);
  const json = toJson(report);
  const runId = `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  const outputDir = join(process.env.RUNNER_TEMP ?? root, 'criteriatrace', runId);
  await mkdir(outputDir, { recursive: true });
  const jsonPath = join(outputDir, 'report.json');
  const markdownPath = join(outputDir, 'report.md');
  await Promise.all([writeFile(jsonPath, json), writeFile(markdownPath, markdown)]);

  await core.summary.addRaw(markdown).write();
  core.setOutput('json-report-path', jsonPath);
  core.setOutput('markdown-report-path', markdownPath);
  core.setOutput('summary', JSON.stringify(report.summary));
  core.setOutput('head', report.head);
  core.setOutput('base', report.base);

  const comment = core.getInput('comment').toLowerCase() === 'true';
  if (comment && !isFork && token) {
    try {
      await upsertComment(token, pull.number, markdown, remote);
    } catch (error) {
      core.warning(
        `Could not update the CriteriaTrace PR comment: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
      );
    }
  } else if (comment)
    core.warning(
      'PR comment was skipped: comments are limited to same-repository PRs with github-token provided.',
    );

  const failedExecution = report.executions.some(
    (execution) =>
      execution.id.startsWith('head-') && (execution.exitCode !== 0 || execution.timedOut),
  );
  const failedPolicy = report.criteria.some((criterion) =>
    config.policy.failOn.includes(criterion.status),
  );
  if (failedExecution)
    core.setFailed(
      'A head verification command did not pass. See the CriteriaTrace report in the job summary.',
    );
  else if (failedPolicy)
    core.setFailed(`CriteriaTrace policy failed for: ${config.policy.failOn.join(', ')}.`);
}

function ensureCommit(root: string, side: 'base' | 'head', sha: string): void {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw new Error(
      `Pull request ${side} revision ${sha} is absent. Configure checkout with fetch-depth: 0.`,
    );
  }
}

function gitShow(root: string, object: string): string | undefined {
  try {
    return git(root, ['show', '--no-textconv', object], 1_000_000);
  } catch {
    return undefined;
  }
}

async function upsertComment(
  token: string,
  issueNumber: number,
  markdown: string,
  remote: string | undefined,
): Promise<void> {
  if (!remote) throw new Error('A trusted GitHub origin is required before writing a comment.');
  const octokit = github.getOctokit(token, { baseUrl: githubApiBase(remote) });
  const { owner, repo } = github.context.repo;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (item) => item.user?.type === 'Bot' && item.body?.includes(reportMarker),
  );
  const body = `${reportMarker}\n${markdown}`.slice(0, 60_000);
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

main().catch((error: unknown) => {
  core.setFailed(redactSensitiveText(error instanceof Error ? error.message : String(error)));
});
