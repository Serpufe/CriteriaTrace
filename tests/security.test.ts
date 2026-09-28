import { describe, expect, it } from 'vitest';
import { redactCommand, redactSensitiveData, redactSensitiveText } from '../src/security.js';

describe('sensitive data handling', () => {
  it('redacts common credential formats and labeled values', () => {
    const openAiKey = ['sk', 'proj', 'x'.repeat(24)].join('-');
    const githubToken = ['github', 'pat', 'x'.repeat(24)].join('_');
    const value = `OPENAI_API_KEY=${openAiKey} ${githubToken}`;
    const redacted = redactSensitiveText(value);
    expect(redacted).not.toContain(openAiKey);
    expect(redacted).not.toContain(githubToken);
    expect(redacted).toContain('OPENAI_API_KEY=[REDACTED]');
  });

  it('redacts both flag=value and flag value command arguments', () => {
    expect(
      redactCommand(['tool', '--api-key=first-secret', '--token', 'second-secret', 'normal']),
    ).toEqual(['tool', '--api-key=[REDACTED]', '--token', '[REDACTED]', 'normal']);
  });

  it('redacts report fields recursively without changing the input', () => {
    const value = {
      source: 'token: first-secret-value',
      executions: [{ output: 'Authorization: Bearer second-secret-value' }],
    };
    const redacted = redactSensitiveData(value);
    expect(JSON.stringify(redacted)).not.toContain('first-secret-value');
    expect(JSON.stringify(redacted)).not.toContain('second-secret-value');
    expect(value.source).toContain('first-secret-value');
  });

  it('processes many unmatched private-key markers within a bounded time', () => {
    const input = '-----BEGIN PRIVATE KEY-----'.repeat(25_000);
    const started = performance.now();
    redactSensitiveText(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('still redacts a complete private key block after unmatched markers', () => {
    const result = redactSensitiveText(
      '-----BEGIN PRIVATE KEY-----\n' +
        '-----BEGIN RSA PRIVATE KEY-----\nfixture-private-material\n-----END RSA PRIVATE KEY-----',
    );
    expect(result).not.toContain('fixture-private-material');
  });

  it('redacts a private key block whose output was cut before the closing marker', () => {
    const redacted = redactSensitiveText(
      '-----BEGIN PRIVATE KEY-----\nfixture-private-material-without-end',
    );
    expect(redacted).not.toContain('fixture-private-material-without-end');
    expect(redacted).toContain('[REDACTED PRIVATE KEY]');
  });

  it('redacts armored PGP private key blocks', () => {
    const redacted = redactSensitiveText(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture-pgp-private-material\n-----END PGP PRIVATE KEY BLOCK-----',
    );
    expect(redacted).not.toContain('fixture-pgp-private-material');
  });
});
