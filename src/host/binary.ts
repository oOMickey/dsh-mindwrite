import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MindError } from '../model.ts';
import { READ_ONLY } from './errors.ts';

/** rc.3 has no writeBytes. Reserve through DSH, then fill only the same owned,
 * empty local file descriptor. Permission checks and cleanup stay with DSH.
 * Never truncate, overwrite, follow a final symlink, or delete a replaced file. */
export async function writeBinaryExclusive(
  ctx: Context,
  target: FsTarget,
  bytes: Buffer,
  sandboxPolicy: SandboxExecutionPolicy,
): Promise<void> {
  if (sandboxPolicy.mode === 'read-only') throw new MindError('READ_ONLY', READ_ONLY);
  const fresh = await ctx.fs.resolve(target.displayPath);
  const root = await ctx.fs.resolve(sandboxPolicy.workspaceRoot);
  if (!ctx.fs.contains(root, fresh)) throw new MindError('PATH', '文件必须位于当前工作区内');
  const url = ctx.fs.fileUrl(fresh);
  if (!url.startsWith('file:')) throw new MindError('FILESYSTEM', '导出需要 Desktop 本地文件系统');
  const reserved = await ctx.fs.writeText(
    fresh,
    '',
    { kind: 'createIfAbsent' },
    undefined,
    sandboxPolicy,
  );
  const local = fileURLToPath(url);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let owned: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    const before = await lstat(local);
    handle = await open(local, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptor = await handle.stat();
    const current = await ctx.fs.stat(fresh);
    if (
      !before.isFile() ||
      descriptor.dev !== before.dev ||
      descriptor.ino !== before.ino ||
      descriptor.size !== 0 ||
      current?.version !== reserved.version
    )
      throw new MindError('CONFLICT', '导出文件被其他程序修改，请重试');
    owned = descriptor;
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle?.close();
    handle = undefined;
    // Guard cleanup by both identity and DSH version; retain uncertain files.
    const now = await lstat(local).catch(() => undefined);
    const info = await ctx.fs.stat(fresh).catch(() => undefined);
    if (
      info &&
      now &&
      (owned ? now.dev === owned.dev && now.ino === owned.ino : info.version === reserved.version)
    )
      await ctx.fs
        .deleteFile(fresh, { version: info.version }, undefined, sandboxPolicy)
        .catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
}
