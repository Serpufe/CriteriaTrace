import type { RequirementSource } from './types.js';
import { z } from 'zod';

const maxIssueResponseBytes = 1_048_576;
const issueResponseSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(4096),
  body: z.string().max(maxIssueResponseBytes).nullable(),
  html_url: z.string().url().max(4096),
});

export function githubSlug(remote: string): { owner: string; repo: string } | undefined {
  const normalized = remote
    .replace(/^[^@/]+@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/[^@/]+@/, 'https://');
  try {
    const url = new URL(normalized);
    const parts = url.pathname
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    if (parts.length < 2) return undefined;
    if (url.hostname.toLowerCase() !== 'github.com') {
      if (!process.env.GITHUB_API_URL) return undefined;
      const apiUrl = new URL(process.env.GITHUB_API_URL);
      if (apiUrl.hostname.toLowerCase() !== url.hostname.toLowerCase())
        return undefined;
    }
    return { owner: parts.at(-2)!, repo: parts.at(-1)! };
  } catch {
    return undefined;
  }
}

export function githubApiBase(remote: string): string {
  if (!githubSlug(remote)) {
    throw new Error('Could not determine a trusted GitHub owner/repository from origin.');
  }
  const remoteHost = remoteHostname(remote);
  const configuredApi = process.env.GITHUB_API_URL;
  const apiUrl = new URL(configuredApi ?? 'https://api.github.com');
  if (
    apiUrl.protocol !== 'https:' ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error('GITHUB_API_URL must be an HTTPS URL without credentials, query, or fragment.');
  }
  const apiHost = apiUrl.hostname.toLowerCase();
  const publicGitHub =
    remoteHost === 'github.com' && (apiHost === 'api.github.com' || apiHost === 'github.com');
  const enterpriseGitHub = remoteHost !== 'github.com' && apiHost === remoteHost;
  if (!publicGitHub && !enterpriseGitHub) {
    throw new Error(
      'GITHUB_API_URL must use GitHub.com or match the GitHub Enterprise origin host.',
    );
  }
  return apiUrl.toString().replace(/\/+$/, '');
}

export async function fetchIssueSource(
  remote: string,
  issueNumber: number,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
): Promise<RequirementSource> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new Error('Issue number must be positive.');
  const slug = githubSlug(remote);
  if (!slug) throw new Error('Could not determine a trusted GitHub owner/repository from origin.');
  const apiBase = githubApiBase(remote);
  const url = new URL(
    `repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}/issues/${issueNumber}`,
    `${apiBase}/`,
  );
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const message =
      response.status === 404
        ? 'Issue not found or not readable. Check the repository and token permissions.'
        : `GitHub issue request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  const payload = await readJsonLimited(response, maxIssueResponseBytes);
  const parsed = issueResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.number !== issueNumber) {
    throw new Error(
      'GitHub issue response did not match the requested issue or exceeded field limits.',
    );
  }
  const issue = parsed.data;
  const issueUrl = new URL(issue.html_url);
  if (
    issueUrl.protocol !== 'https:' ||
    issueUrl.hostname.toLowerCase() !== remoteHostname(remote) ||
    issueUrl.username ||
    issueUrl.password
  ) {
    throw new Error('GitHub issue response contained an untrusted issue URL.');
  }
  return {
    id: `github-issue-${issue.number}`,
    kind: 'github-issue',
    title: `#${issue.number} ${issue.title}`,
    url: issue.html_url,
    text: issue.body?.trim() ? issue.body : `# ${issue.title}`,
  };
}

async function readJsonLimited(response: Response, maxBytes: number): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error(`GitHub issue response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) throw new Error('GitHub issue response has no body.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`GitHub issue response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch {
    throw new Error('GitHub issue response was not valid JSON.');
  }
}

function remoteHostname(remote: string): string {
  const normalized = remote
    .replace(/^[^@/]+@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/[^@/]+@/, 'https://');
  return new URL(normalized).hostname.toLowerCase();
}
