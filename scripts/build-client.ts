import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileStyle } from '../src/style-tokens.ts';

export async function buildClient() {
  const css = compileStyle(await readFile('src/style.css', 'utf8'));
  const client = await build({
    entryPoints: ['src/client.tsx'],
    bundle: true,
    preserveSymlinks: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    plugins: [
      {
        name: 'mindwrite-style',
        setup(build) {
          build.onLoad({ filter: /[/\\]src[/\\]style\.css$/ }, () => ({
            contents: css,
            loader: 'text',
          }));
        },
      },
    ],
    write: false,
    minify: true,
    metafile: true,
  });
  const wrapper = "window.__ModuleLoader__.load({id:'dsh-mindwrite',factory(require){";
  return {
    js: `${wrapper}const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});`,
    css,
    metafile: client.metafile,
  };
}

export async function writeClient(
  directory: string,
  prepared?: Awaited<ReturnType<typeof buildClient>>,
) {
  const client = prepared ?? (await buildClient());
  await writeFile(join(directory, 'client.js'), client.js);
  await writeFile(join(directory, 'style.css'), client.css);
  return client.metafile;
}
