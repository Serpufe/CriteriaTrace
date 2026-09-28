import type { Criterion, FileEvidence } from './types.js';

const ignored = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'with',
  'when',
  'where',
  'will',
  'must',
  'should',
  'can',
  'has',
  'have',
  'does',
  'user',
  'users',
  'system',
  'requirement',
  'criteria',
  'criterion',
  'should',
  'support',
  'ensure',
  'allow',
  'return',
]);

export function tokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
      (token) => !ignored.has(token),
    ),
  );
}

export function overlapScore(requirement: string, content: string): number {
  const wanted = tokens(requirement);
  if (wanted.size === 0) return 0;
  const available = tokens(content);
  let found = 0;
  for (const token of wanted) if (available.has(token)) found += 1;
  return found / wanted.size;
}

export interface CandidateFile {
  path: string;
  content: string;
  changed: boolean;
  test: boolean;
}

export function isTestPath(path: string): boolean {
  if (isTestSupportPath(path)) return false;
  const extension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb)$/i.test(path);
  if (!extension) return false;
  return (
    /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$/i.test(path) ||
    /(^|\/)(?:test|tests|__tests__)\//i.test(path)
  );
}

export function isSourcePath(path: string): boolean {
  return (
    !isTestSupportPath(path) &&
    /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb)$/i.test(path) &&
    !isTestPath(path)
  );
}

function isTestSupportPath(path: string): boolean {
  const segments = path.split('/');
  const testDirectoryIndex = segments.findIndex((segment) =>
    /^(?:test|tests|__tests__)$/i.test(segment),
  );
  if (testDirectoryIndex < 0) return false;
  const tail = segments.slice(testDirectoryIndex + 1);
  return (
    tail.some((segment) => /^(?:fixtures|__fixtures__)$/i.test(segment)) ||
    /^(?:helpers?|utils?|setup|teardown)\.[^.]+$/i.test(tail.at(-1) ?? '')
  );
}

export function hasExplicitCriterionReference(
  path: string,
  content: string,
  criterionId: string,
  relation: 'implementation' | 'test',
): boolean {
  const escapedId = criterionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('-', '[-_ ]?');
  const id = `\\b${escapedId}\\b`;
  if (new RegExp(id, 'i').test(path)) return true;
  if (relation === 'test') {
    const testLabel = new RegExp(
      '\\b(?:test|it|describe)\\s*\\(\\s*[\'"`][^\'"`\\r\\n]*' + id,
      'i',
    );
    return testLabel.test(content);
  }
  const marker = new RegExp(
    `^\\s*(?:\\/\\/|\\/\\*+|\\*|#|<!--)\\s*(?:@(?:criterion|requirement)\\s*)?${id}\\s*(?::|[-–—])`,
    'i',
  );
  return content.split(/\r?\n/).some((line) => marker.test(line));
}

export function lexicalEvidence(criterion: Criterion, files: CandidateFile[]): FileEvidence[] {
  const evidence: FileEvidence[] = [];
  const idPattern = new RegExp(`\\b${criterion.id.replace('-', '[-_ ]?')}\\b`, 'i');
  for (const file of files) {
    if (!file.test && !file.changed) continue;
    const relation = file.test ? 'test' : 'implementation';
    const explicit = hasExplicitCriterionReference(file.path, file.content, criterion.id, relation);
    const score = overlapScore(criterion.text, `${file.path}\n${file.content}`);
    if (!explicit && score < (file.test ? 0.22 : 0.16)) continue;
    const lines = file.content.split('\n');
    const matching = lines.findIndex(
      (line) => idPattern.test(line) || overlapScore(criterion.text, line) >= 0.2,
    );
    const start = matching + 1;
    const end = matching >= 0 ? Math.min(lines.length, matching + 4) : undefined;
    const item: FileEvidence = {
      path: file.path,
      relation: file.test ? 'test' : 'implementation',
      method: explicit ? 'explicit-id' : 'lexical',
      note: explicit
        ? `Contains ${criterion.id}.`
        : `Lexical overlap ${Math.round(score * 100)}%; inspect the cited file.`,
    };
    if (end !== undefined) item.lines = `${start}-${end}`;
    evidence.push(item);
  }
  return evidence.sort(
    (a, b) => (a.method === 'explicit-id' ? -1 : 0) - (b.method === 'explicit-id' ? -1 : 0),
  );
}

export function validateModelPaths(paths: string[], allowed: Set<string>): string[] {
  return [...new Set(paths.filter((path) => allowed.has(path)))];
}
