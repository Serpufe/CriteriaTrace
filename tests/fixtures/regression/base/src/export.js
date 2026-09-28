export function exportFilename(name) {
  return name.replace(/[^\x00-\x7f]/g, '');
}
