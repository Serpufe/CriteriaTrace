import console from 'node:console';
import process from 'node:process';
import { sandboxImages } from '../dist/images.js';

const image = sandboxImages[process.argv[2]];
if (!image) {
  console.error('Usage: node scripts/print-sandbox-image.mjs node|python');
  process.exitCode = 2;
} else {
  process.stdout.write(image);
}
