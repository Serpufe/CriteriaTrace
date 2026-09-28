const secretEnvironmentName = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/i;
const sensitiveArgumentName =
  /^(?:--?)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:orization)?|password|passwd|secret|token|credential)(?:$|=)/i;

export function redactSensitiveText(value: string): string {
  let result = value;
  const environmentSecrets = Object.entries(process.env)
    .filter(
      ([name, secret]) =>
        secretEnvironmentName.test(name) && Boolean(secret) && secret!.length >= 8,
    )
    .map(([, secret]) => secret!)
    .sort((left, right) => right.length - left.length);

  for (const secret of environmentSecrets) result = result.replaceAll(secret, '[REDACTED]');

  return redactPrivateKeys(result)
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
      '[REDACTED]',
    )
    .replace(/\b((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b((?:proxy-)?authorization\s*:\s*(?:bearer|token|basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /\b((?:[a-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|token|credential)[a-z0-9_-]*)\s*[=:]\s*)(["']?)[^\s,"';&]+/gi,
      '$1[REDACTED]',
    );
}

function redactPrivateKeys(value: string): string {
  const pieces: string[] = [];
  let start = -1;
  let copiedThrough = 0;
  for (const marker of value.matchAll(/-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gi)) {
    if (marker[1]?.toUpperCase() === 'BEGIN') {
      if (start < 0) start = marker.index;
    } else if (start >= 0) {
      pieces.push(value.slice(copiedThrough, start), '[REDACTED PRIVATE KEY]');
      copiedThrough = marker.index + marker[0].length;
      start = -1;
    }
  }
  if (start >= 0) {
    pieces.push(value.slice(copiedThrough, start), '[REDACTED PRIVATE KEY]');
  } else {
    pieces.push(value.slice(copiedThrough));
  }
  return pieces.join('');
}

export function redactCommand(command: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index]!;
    if (sensitiveArgumentName.test(part)) {
      const separator = part.indexOf('=');
      if (separator >= 0) {
        result.push(`${part.slice(0, separator)}=[REDACTED]`);
      } else {
        result.push(part);
        if (index + 1 < command.length) {
          result.push('[REDACTED]');
          index += 1;
        }
      }
    } else {
      result.push(redactSensitiveText(part));
    }
  }
  return result;
}

export function redactSensitiveData<T>(value: T): T {
  if (typeof value === 'string') return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSensitiveData(item)]),
    ) as T;
  }
  return value;
}
