import { createHash } from 'node:crypto';
import type { Criterion, RequirementSource } from './types.js';

export const maxCriteria = 500;
const maxCriterionIdLength = 64;

function fallbackId(sourceId: string, text: string): string {
  return `REQ-${createHash('sha256')
    .update(sourceId + text)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase()}`;
}

export function parseCriteria(source: RequirementSource): Criterion[] {
  const lines = source.text.replace(/\r\n/g, '\n').split('\n');
  const criteria: Criterion[] = [];
  let requirementsHeadingLevel: number | undefined;
  let sequence = 0;

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = line.match(/^\s{0,3}#+/)?.[0].trim().length ?? 0;
      const isRequirementHeading =
        /\b(acceptance criteria|criteria|requirements|expected behavior)\b/i.test(heading[1] ?? '');
      if (isRequirementHeading) requirementsHeadingLevel = level;
      else if (requirementsHeadingLevel !== undefined && level <= requirementsHeadingLevel)
        requirementsHeadingLevel = undefined;
      continue;
    }
    const labeled = line.match(/^\s*(?:[-*+]\s*)?(AC|REQ)[-_ ]?(\d+)\s*[:.)-]\s*(.+?)\s*$/i);
    const bullet =
      requirementsHeadingLevel !== undefined
        ? line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/)
        : null;
    const rawText = (labeled?.[3] ?? bullet?.[1] ?? '').trim();
    if (!rawText || /^criteria\s*$/i.test(rawText)) continue;
    const notApplicable = /^\[(?:N\/A|NOT APPLICABLE)\]\s*/i.test(rawText);
    const text = rawText.replace(/^\[(?:N\/A|NOT APPLICABLE)\]\s*/i, '').trim();
    if (!text) continue;
    sequence += 1;
    const id = labeled ? `${(labeled[1] ?? 'AC').toUpperCase()}-${labeled[2]}` : `AC-${sequence}`;
    if (id.length > maxCriterionIdLength)
      throw new Error(`Criterion ID exceeds ${maxCriterionIdLength} characters.`);
    if (criteria.length >= maxCriteria)
      throw new Error(`Too many criteria; limit is ${maxCriteria}.`);
    criteria.push({
      id,
      text,
      origin: 'explicit',
      sourceId: source.id,
      ...(notApplicable ? { notApplicable: true } : {}),
    });
  }

  if (criteria.length > 0) return criteria;
  const body = source.text.replace(/^\s{0,3}#{1,6}\s+.+$/gm, '').trim();
  if (!body) return [];
  return [
    {
      id: fallbackId(source.id, body),
      text: body.slice(0, 4000),
      origin: 'explicit',
      sourceId: source.id,
    },
  ];
}

export function markdownSource(path: string, text: string): RequirementSource {
  return { id: 'local-spec', kind: 'markdown', title: path, text };
}
