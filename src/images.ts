// Update these together in a reviewed release change. See docs/releasing.md.
// The digest pins the multi-platform index; the tag documents the intended runtime line.
export const sandboxImages = {
  node: 'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1',
  python:
    'python:3.13-alpine@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f',
} as const;
