import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { buildClient, writeClient } from './build-client.ts';
import { bundledLicenses } from './licenses.mjs';

const host = await build({
  entryPoints: ['src/host.ts'],
  outfile: 'dist/host.js',
  bundle: true,
  // Preserve checkout-relative module names when dependencies are symlinked.
  preserveSymlinks: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  write: false,
  metafile: true,
  external: ['@deepseek-ai/*'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
for (const output of Object.values(host.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (
      dependency.external &&
      !isBuiltin(dependency.path) &&
      !dependency.path.startsWith('@deepseek-ai/')
    ) {
      throw new Error(`Runtime dependency was not bundled: ${dependency.path}`);
    }
  }
}
const client = await buildClient();
const { notices, bundled } = await bundledLicenses({
  'dist/host.js': host.metafile,
  'dist/client.js': client.metafile,
});
await mkdir('dist', { recursive: true });
await writeFile('dist/host.js', host.outputFiles[0].contents);
await writeClient('dist', client);
await writeFile('THIRD-PARTY-NOTICES.md', notices);
await writeFile('dist/bundled-dependencies.json', JSON.stringify(bundled, null, 2) + '\n');
