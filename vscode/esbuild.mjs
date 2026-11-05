// Bundles the extension (and the test entry points) into self-contained CJS.
//
// The transport core lives in ../plugin/src and is shared with the DSH plugin; bundling
// inlines it so the installed VSIX does not depend on the sibling directory.
import esbuild from 'esbuild';
import fs from 'node:fs';

const testsOnly = process.argv.includes('--tests');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'warning',
};

if (!testsOnly) {
  fs.mkdirSync('dist', { recursive: true });
  await esbuild.build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' });
  console.log('built dist/extension.js');
}

if (testsOnly || process.argv.includes('--all')) {
  fs.mkdirSync('.tmp', { recursive: true });
  for (const [entry, out] of [['test/unit.test.ts', '.tmp/unit.test.cjs'], ['test/live.test.ts', '.tmp/live.test.cjs']]) {
    await esbuild.build({ ...common, entryPoints: [entry], outfile: out });
  }
  console.log('built test bundles');
}
