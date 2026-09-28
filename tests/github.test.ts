import { describe, expect, it, vi } from 'vitest';
import { fetchIssueSource, githubApiBase, githubSlug } from '../src/github.js';

describe('GitHub remote parsing', () => {
  it('reads HTTPS and SSH origin forms', () => {
    expect(githubSlug('https://github.com/Serpufe/criteriatrace.git')).toEqual({
      owner: 'Serpufe',
      repo: 'criteriatrace',
    });
    expect(githubSlug('git@github.com:Serpufe/criteriatrace.git')).toEqual({
      owner: 'Serpufe',
      repo: 'criteriatrace',
    });
  });

  it('does not mistake unrelated hosts for GitHub without an API base', () => {
    expect(githubSlug('https://gitlab.com/owner/repo.git')).toBeUndefined();
  });

  it('rejects unrelated hosts with the GitHub Actions API URL set', () => {
    const previous = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = 'https://api.github.com';
    try {
      expect(githubSlug('https://gitlab.com/owner/repo.git')).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = previous;
    }
  });

  it('rejects GitHub-like attacker domains before sending an issue token', async () => {
    const originalApiUrl = process.env.GITHUB_API_URL;
    const originalFetch = globalThis.fetch;
    delete process.env.GITHUB_API_URL;
    const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      const remote = 'https://github.com.attacker.example/owner/repo.git';
      expect(githubSlug(remote)).toBeUndefined();
      await expect(fetchIssueSource(remote, 7, 'test-token')).rejects.toThrow(
        'trusted GitHub owner/repository',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = originalApiUrl;
    }
  });

  it('keeps GitHub API credentials on an HTTPS endpoint matching the remote host', async () => {
    const originalApiUrl = process.env.GITHUB_API_URL;
    const originalFetch = globalThis.fetch;
    process.env.GITHUB_API_URL = 'http://github.enterprise.example/api/v3';
    const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      await expect(
        fetchIssueSource('https://github.enterprise.example/owner/repo.git', 7, 'test-token'),
      ).rejects.toThrow('HTTPS URL');
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.GITHUB_API_URL = 'https://github.enterprise.example/api/v3';
      let requestedUrl = '';
      let authorization = '';
      let redirect: RequestRedirect | undefined;
      const trustedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        redirect = init?.redirect;
        return new Response(
          JSON.stringify({
            number: 7,
            title: 'Issue',
            body: 'Issue text',
            html_url: 'https://github.enterprise.example/owner/repo/issues/7',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      vi.stubGlobal('fetch', trustedFetch);
      const issue = await fetchIssueSource(
        'https://github.enterprise.example/owner/repo.git',
        7,
        'test-token',
      );
      expect(issue.title).toBe('#7 Issue');
      expect(requestedUrl).toBe(
        'https://github.enterprise.example/api/v3/repos/owner/repo/issues/7',
      );
      expect(authorization).toBe('Bearer test-token');
      expect(redirect).toBe('error');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = originalApiUrl;
    }
  });

  it('rejects API hosts that do not match the origin before using a GitHub token', async () => {
    const originalApiUrl = process.env.GITHUB_API_URL;
    const originalFetch = globalThis.fetch;
    process.env.GITHUB_API_URL = 'https://attacker.example/api';
    const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      expect(() => githubApiBase('https://github.com/owner/repo.git')).toThrow(
        'match the GitHub Enterprise origin host',
      );
      await expect(
        fetchIssueSource('https://github.com/owner/repo.git', 1, 'test-token'),
      ).rejects.toThrow('match the GitHub Enterprise origin host');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = originalApiUrl;
    }
  });

  it('bounds and validates the GitHub issue response payload', async () => {
    const originalApiUrl = process.env.GITHUB_API_URL;
    const originalFetch = globalThis.fetch;
    delete process.env.GITHUB_API_URL;
    const mockFetch = vi.fn(async () => new Response('x'.repeat(1_048_577), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      await expect(fetchIssueSource('https://github.com/owner/repo.git', 7)).rejects.toThrow(
        'byte limit',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                number: '7',
                title: 'Issue',
                body: 'Issue text',
                html_url: 'https://attacker.example/owner/repo/issues/7',
              }),
              { status: 200 },
            ),
        ),
      );
      await expect(fetchIssueSource('https://github.com/owner/repo.git', 7)).rejects.toThrow(
        'did not match the requested issue',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                number: 7,
                title: 'Issue',
                body: 'Issue text',
                html_url: 'https://attacker.example/owner/repo/issues/7',
              }),
              { status: 200 },
            ),
        ),
      );
      await expect(fetchIssueSource('https://github.com/owner/repo.git', 7)).rejects.toThrow(
        'untrusted issue URL',
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = originalApiUrl;
    }
  });
});
