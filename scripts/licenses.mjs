import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

// Pins the component list as well as the complete texts. Removing an embedded entry
// must fail even if that package also happens to be installed separately by npm.
const inventoryDigest = '1c4360a036d8459f950b169c36899a24d038173155a11d9b5d0adcd2fa3203ac';
const inventory = await readJson(new URL('./bundled-licenses.json', import.meta.url));
if (sha256(JSON.stringify(inventory)) !== inventoryDigest) {
  throw new Error(
    'Bundled license inventory is incomplete or has changed. Verify its upstream sources.',
  );
}

async function readLicenses(directory, id) {
  const files = inventory.direct[id];
  if (!files) throw new Error(`No audited license files for bundled package ${id}`);
  const licenses = [];
  for (const [name, digest] of Object.entries(files)) {
    const raw = await readFile(join(directory, name), 'utf8');
    const text = raw
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
    if (!text || sha256(text) !== digest)
      throw new Error(`Incomplete or changed license: ${id}/${name}`);
    if (id.startsWith('jszip@')) {
      // Both upstream JSZip versions offer the full MIT text before the GPL alternative.
      const mit = /^(The MIT License\n=+\n[\s\S]+?)\n+GPL version 3\n=+/m.exec(text);
      if (!mit) throw new Error(`Missing MIT license: ${id}/${name}`);
      licenses.push({ name: `${name} (MIT)`, text: mit[1].trim() });
    } else if (name === 'README.md') {
      // The isarray README ends with its license.
      const section = text.split('\n## License\n')[1]?.trim();
      if (!section?.includes('Permission is hereby granted'))
        throw new Error(`Missing license section: ${id}`);
      licenses.push({ name: `${name} (License section)`, text: section });
    } else {
      licenses.push({ name, text });
    }
  }
  return licenses;
}

function includedPackages(artifacts) {
  const directories = new Map();
  function include(directory, input, artifact) {
    if (!directories.has(directory))
      directories.set(directory, { inputs: new Set(), bundledBy: new Set() });
    directories.get(directory).inputs.add(input);
    directories.get(directory).bundledBy.add(artifact);
  }
  for (const [artifact, metafile] of Object.entries(artifacts)) {
    // esbuild's injected module helpers are present in both outputs but have no input path.
    include('node_modules/esbuild', 'runtime helpers', artifact);
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        const path = input.replaceAll('\\', '/');
        const directory = /^(.*\bnode_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1];
        if (directory && bytesInOutput > 0) include(directory, path, artifact);
      }
    }
  }
  return directories;
}

export async function bundledLicenses(artifacts) {
  const lock = await readJson('package-lock.json');
  const components = new Map();
  function add(entry) {
    const id = `${entry.name}@${entry.version}`;
    const previous = components.get(id);
    if (!previous) {
      components.set(id, {
        ...entry,
        bundledBy: [...entry.bundledBy],
        licenses: [...entry.licenses],
      });
      return;
    }
    if (entry.license !== previous.license || entry.source !== previous.source)
      throw new Error(`Inconsistent metadata for ${id}`);
    previous.bundledBy.push(...entry.bundledBy);
    for (const file of entry.licenses) {
      const same = previous.licenses.find((item) => item.name === file.name);
      if (!same) previous.licenses.push(file);
      else if (same.text !== file.text)
        throw new Error(`Conflicting license texts: ${id}/${file.name}`);
    }
  }
  for (const [directory, { inputs, bundledBy }] of includedPackages(artifacts)) {
    const { name, version, license } = await readJson(join(directory, 'package.json'));
    const id = `${name}@${version}`;
    const locked = lock.packages[directory];
    if (!locked?.resolved || locked.version !== version)
      throw new Error(`Missing or mismatched lock entry: ${directory}`);
    if (!license || license !== locked.license)
      throw new Error(`Missing or mismatched license declaration: ${id}`);
    add({
      name,
      version,
      license,
      source: locked.resolved,
      bundledBy,
      ...(name === 'jszip' && { selectedLicense: 'MIT' }),
      licenses: await readLicenses(directory, id),
    });
    if (name === 'docx') {
      const audited = inventory.docx;
      const path = `${directory}/${audited.entry}`;
      if (
        version !== audited.version ||
        inputs.size !== 1 ||
        !inputs.has(path) ||
        sha256(await readFile(path)) !== audited.sha256
      ) {
        throw new Error('The embedded components of this docx bundle have not been verified.');
      }
      for (const component of audited.components) add(component);
    }
  }
  const bundled = [...components.keys()].sort().map((id) => components.get(id));
  let notices = '# Third-party notices\n\n';
  notices +=
    'Mindwrite bundles the components below for offline use. DSH and React are supplied by the host. ';
  notices +=
    'For both JSZip versions this distribution uses the MIT option. Both pako versions retain MIT and Zlib.\n';
  notices += `\nEmbedded components were identified from the [docx build](${inventory.docx.lockfile}), the [JSZip browser bundle](${inventory.docx.jszipLockfile}) and the [Vite CommonJS runtime](${inventory.docx.viteLockfile}).\n`;
  for (const component of bundled) {
    component.bundledBy = [...new Set(component.bundledBy)].sort();
    const selected = component.selectedLicense
      ? ` (used under ${component.selectedLicense} in this distribution)`
      : '';
    notices += `\n## ${component.name}@${component.version}\n\nLicense: ${component.license}${selected}.\n\n`;
    notices += `Included by ${component.bundledBy.join(', ')}. [Upstream source](${component.source})\n`;
    for (const { name, text, source } of component.licenses) {
      notices += `\n### ${name}\n`;
      if (source) notices += `\n[Upstream license](${source})\n`;
      notices += '\n```text\n' + text + '\n```\n';
    }
  }
  return { notices, bundled };
}
