import type { CriterionResult, TraceReport } from './types.js';
import { redactSensitiveData } from './security.js';

export function toJson(report: TraceReport): string {
  return `${JSON.stringify(redactSensitiveData(report), null, 2)}\n`;
}

export function toMarkdown(report: TraceReport): string {
  report = redactSensitiveData(report);
  const lines = [
    '# CriteriaTrace report',
    '',
    `**Schema:** ${report.schemaVersion}  `,
    `**Repository:** ${escapeCell(report.repository.remote ?? report.repository.root)}  `,
    `**Base:** ${inlineCode(report.base)}  `,
    `**Head:** ${inlineCode(report.head)}  `,
    `**Execution:** ${report.executionPolicy ? `${report.executionPolicy.mode}; network ${report.executionPolicy.network}` : 'unspecified'}  `,
    `**Generated:** ${report.createdAt}`,
    '',
    '## Summary',
    '',
    '| Status | Count |',
    '| --- | ---: |',
    ...Object.entries(report.summary).map(([status, count]) => `| ${status} | ${count} |`),
    '',
    '## Traceability matrix',
    '',
    '| Criterion | Origin | Status | Implementation | Tests | Reason |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.criteria.map(matrixRow),
    '',
    '## Executions',
    '',
  ];
  if (report.executions.length === 0) {
    lines.push('No commands were executed.');
  } else {
    lines.push(
      '| ID | Revision | Command | Result | Duration |',
      '| --- | --- | --- | --- | ---: |',
    );
    for (const execution of report.executions) {
      const result = execution.timedOut
        ? 'TIMEOUT'
        : execution.termination === 'output-limit'
          ? 'OUTPUT LIMIT'
          : execution.exitCode === 0
            ? 'EXIT 0 (repository command)'
            : execution.exitCode === null
              ? 'NOT RUN'
              : `FAIL (exit ${execution.exitCode})`;
      lines.push(
        `| ${escapeCell(execution.id)} | ${inlineCode(execution.revision.slice(0, 12))} | ${inlineCode(execution.command.join(' ') || '(none)')} | ${result} | ${execution.durationMs} ms |`,
      );
      if (execution.output) {
        const fence = codeFence(execution.output);
        lines.push(
          '',
          '<details>',
          `<summary>${escapeCell(execution.id)} output</summary>`,
          '',
          `${fence}text`,
          execution.output,
          fence,
          '',
          '</details>',
          '',
        );
      }
      if (execution.outputTruncated)
        lines.push(
          '',
          `Output for ${escapeCell(execution.id)} was truncated by the configured limit.`,
          '',
        );
    }
  }
  if (report.generatedTests.length > 0) {
    lines.push('', '## Generated tests', '');
    for (const test of report.generatedTests) {
      lines.push(
        `### ${escapeCell(test.criterionId)} — ${escapeCell(test.fileName)}`,
        '',
        `Advisory test. ${escapeCell(test.rationale)}`,
        '',
        codeFence(test.source),
        test.source,
        codeFence(test.source),
        '',
        `Executions: ${test.executions.map(escapeCell).join(', ') || 'none'}`,
        '',
      );
    }
  }
  lines.push('## Sources', '');
  for (const source of report.sources) {
    const href = source.url ? ` — [${escapeCell(source.url)}](${safeUrl(source.url)})` : '';
    lines.push(`- **${escapeCell(source.kind)}:** ${escapeCell(source.title)}${href}`);
  }
  lines.push('', '## Limitations', '');
  if (report.limitations.length === 0) lines.push('None recorded.');
  else for (const limitation of report.limitations) lines.push(`- ${escapeCell(limitation)}`);
  lines.push(
    '',
    '> A CriteriaTrace status summarizes collected links and process results. It does not prove the change is bug-free or replace review.',
    '',
  );
  return lines.join('\n');
}

function matrixRow(result: CriterionResult): string {
  const implementations = result.implementationEvidence.map(formatEvidence).join('<br>') || '—';
  const tests = result.testEvidence.map(formatEvidence).join('<br>') || '—';
  return `| **${escapeCell(result.id)}** ${escapeCell(result.text)} | ${result.origin} | **${result.status}** | ${implementations} | ${tests} | ${escapeCell(result.reason)} |`;
}

function formatEvidence(item: CriterionResult['implementationEvidence'][number]): string {
  const location = item.lines ? `${item.path}:${item.lines}` : item.path;
  return `${inlineCode(location)} (${escapeCell(item.method)})`;
}

function escapeCell(value: string): string {
  let escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', ' ');
  for (const character of [
    '`',
    '*',
    '_',
    '{',
    '}',
    '[',
    ']',
    '(',
    ')',
    '#',
    '+',
    '.',
    '!',
    '|',
    '~',
    '>',
    '-',
  ]) {
    escaped = escaped.replaceAll(character, `\\${character}`);
  }
  return escaped;
}

function inlineCode(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|');
  const runs = normalized.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const padding = /^(?:`| )|(?:`| )$/.test(normalized) ? ' ' : '';
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function codeFence(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '#';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|auth|key|signature)/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString().replaceAll(')', '%29');
  } catch {
    return '#';
  }
}
