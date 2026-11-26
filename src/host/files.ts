import { inferDocumentType, typeDefaults } from '../document-profile.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, relative, sep } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type {} from '@deepseek-ai/dsh-session-query';
import { importSummary, warningExcerpts, type ImportResult } from '../import.ts';
import { writeBinaryExclusive } from './binary.ts';
import { READ_ONLY } from './errors.ts';
import { z } from 'zod';
import { DocumentStore, token, type Snapshot, type Commit, type ReviewFileKind } from '../store.ts';
import { appliedNodeIds } from '../history.ts';
import { MindError, type NodeInput } from '../model.ts';
import {
  cleanFilename,
  MAX_FILENAME_BYTES,
  documentFilename,
  isDocumentPath,
  saveUniqueExport,
} from '../filenames.ts';

const badgeCache = new WeakMap<Snapshot, string[]>();
export function snapshotView(s: Snapshot, path: string, includeImportNumbering = true) {
  const d = s.document;
  const latest = d.history.at(-1);
  const adoptedIds =
    badgeCache.get(s) ??
    (d.cursor && d.history[d.cursor - 1]?.label === 'AI'
      ? appliedNodeIds([d.history[d.cursor - 1]], 1)
      : []);
  badgeCache.set(s, adoptedIds);
  return {
    path,
    id: d.id,
    revision: s.revision,
    token: s.token,
    root: d.root,
    ...(d.documentType !== undefined && { documentType: d.documentType }),
    ...(d.numberingScheme !== undefined && { numberingScheme: d.numberingScheme }),
    ...(includeImportNumbering && d.importNumbering && { importNumbering: d.importNumbering }),
    expansionDefault: d.expansionDefault ?? 'one',
    hasSource: !!d.sourceRoot,
    ...(d.importReport
      ? {
          importReport: d.importReport,
          importSummary: {
            ...importSummary(d.sourceRoot ?? d.root),
            ...(includeImportNumbering &&
              d.sourceRoot &&
              d.importNumbering?.warnings?.length && {
                excerpts: warningExcerpts(d.sourceRoot, d.importNumbering.warnings),
              }),
          },
        }
      : {}),
    ...(d.historyLimited ? { historyLimited: true } : {}),
    ...(latest?.label === 'AI' ? { adoptionId: latest.id } : {}),
    adoptedIds,
    canUndo: d.cursor > 0,
    canRedo: d.cursor < d.history.length,
    lastAi: d.history[d.cursor - 1]?.label === 'AI',
  };
}

export function createFiles(ctx: Context) {
  const execution = new AsyncLocalStorage<Session>();
  // A state request resolves the workspace several times. Cold session headers
  // are persisted on disk, so share that read within the request only. Never
  // cache a session's permissions or a canonical filesystem target here.
  const requests = new AsyncLocalStorage<Map<string, Promise<string>>>();
  function withRequest<T>(work: () => Promise<T>): Promise<T> {
    return requests.run(new Map(), work);
  }
  const scopedPolicies = new Map<string, SandboxExecutionPolicy>();
  function grantScopeWrites(session: Session) {
    const original = ctx.sandboxPolicy.resolve({ session });
    if (original.mode === 'read-only') throw new MindError('READ_ONLY', READ_ONLY);
    scopedPolicies.set(session.id, ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }));
    return () => scopedPolicies.delete(session.id);
  }
  async function policy(sessionId: string) {
    const scoped = scopedPolicies.get(sessionId);
    if (scoped) return scoped;
    const session = execution.getStore() ?? ctx.sessions.get(sessionId as SessionId);
    const value = session
      ? ctx.sandboxPolicy.resolve({ session })
      : await ctx.sessionQuery.inspectSession(sessionId as SessionId, (session) =>
          ctx.sandboxPolicy.resolve({ session }),
        );
    if (value.mode === 'read-only') throw new MindError('READ_ONLY', READ_ONLY);
    return value;
  }
  function withSession<T>(session: Session, work: () => Promise<T>): Promise<T> {
    return execution.run(session, work);
  }
  const current = new Map<string, string>();
  // SessionHeader.cwd is immutable in rc.3. This cache contains no sandbox
  // policy; every mutation still resolves the live session's policy above.
  const workspaces = new Map<string, string>();
  function forgetWorkspace(sessionId: string) {
    workspaces.delete(sessionId);
    current.delete(sessionId);
  }
  const titles = new Map<string, { version: string; title: string }>();
  type FileList = { path: string; title: string }[];
  const inventories = new Map<
    string,
    { value?: FileList; expires: number; pending?: Promise<FileList> }
  >();
  async function invalidateFiles(sessionId: string) {
    inventories.delete(await workspace(sessionId));
  }
  const maxBytes = 180 * 1024 * 1024;
  async function readRaw(target: FsTarget) {
    const info = await ctx.fs.stat(target);
    if (!info) return undefined;
    if (info.type !== 'file' || (info.size ?? 0) > maxBytes)
      throw new MindError('FILE', '文件类型不支持或超过大小限制');
    const bytes = await ctx.fs.readBytes(target, undefined, maxBytes);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text).equals(bytes)) throw new MindError('FILE', '无法无损读取原件');
    return text;
  }
  async function prepare(
    key: string,
    previous: string | undefined,
    sessionId: string,
  ): Promise<Commit> {
    await policy(sessionId);
    const canonical = await resolve(sessionId, key);
    if (canonical !== key) throw new MindError('PATH', '文件位置已经改变');
    const target = await ctx.fs.resolve(canonical);
    const info = await ctx.fs.stat(target);
    if ((await readRaw(target)) !== previous)
      throw new MindError('CONFLICT', '文件已被其他程序修改');
    const intent = info
      ? { kind: 'replaceIfVersion' as const, version: info.version }
      : { kind: 'createIfAbsent' as const };
    return async (text, check, signal) => {
      const sandboxPolicy = await policy(sessionId);
      if ((await resolve(sessionId, key)) !== canonical)
        throw new MindError('PATH', '文件位置已经改变');
      if ((await ctx.fs.stat(target))?.version !== info?.version)
        throw new MindError('CONFLICT', '文件已被其他程序修改');
      check?.();
      let written;
      try {
        written = await ctx.fs.writeText(target, text, intent, signal, sandboxPolicy);
      } catch (error) {
        const code = (error as { code?: string })?.code ?? '';
        if (
          [
            'FS_STALE_VERSION',
            'FS_ALREADY_EXISTS',
            'FS_NOT_OBSERVED',
            'FS_SANDBOX_DENIED',
          ].includes(code)
        )
          throw error;
        // rc.3 can throw from probe() after the atomic replacement has already succeeded.
        let observed: string | undefined, version;
        try {
          observed = await readRaw(target);
          version = (await ctx.fs.stat(target))?.version;
        } catch {
          throw new MindError('WRITE_UNVERIFIED', '宿主写入结果未验证，主稿无法读回。');
        }
        if (observed === previous && version === info?.version) throw error;
        const result = observed === text ? '读回内容一致' : '读回内容不同';
        throw new MindError('WRITE_UNVERIFIED', `宿主写入结果未验证，${result}，请核对磁盘版本。`);
      }
      // rc.3 returns the version observed after publication. Check both bytes
      // and version: another writer can win before or after that observation.
      try {
        const bytes = await ctx.fs.readBytes(target, undefined, maxBytes);
        const current = await ctx.fs.stat(target);
        if (current?.version === written.version && token(bytes) === token(text)) return;
      } catch {
        // Missing, unreadable and changed targets all require recovery.
      }
      throw new MindError('WRITE_UNVERIFIED', '写入后版本或内容校验失败，请核对磁盘上的文件');
    };
  }
  async function write(
    key: string,
    text: string,
    previous: string | undefined,
    sessionId?: string,
  ) {
    if (!sessionId) throw new MindError('SESSION', '写入需要当前会话');
    await (
      await prepare(key, previous, sessionId)
    )(text);
  }
  async function workspacePath(key: string, sessionId: string) {
    const root = await ctx.fs.resolve(await workspace(sessionId));
    return relative(ctx.fs.processPath(root), await resolve(sessionId, key))
      .split(sep)
      .join('/');
  }
  async function fileKey(key: string, sessionId: string, documentId: string) {
    return token(JSON.stringify([await workspacePath(key, sessionId), documentId]));
  }
  async function backupPath(sessionId: string, name: string) {
    if (!/^0\.7\.3-[a-f0-9]{64}-(?:[a-f0-9]{64}|suggestions|pair-[a-f0-9]{64})\.json$/.test(name))
      throw new MindError('PATH', '备份名称无效');
    return internalPath(sessionId, name, true);
  }
  // rc.3 fsyncs the file before publishing its name. Sync that name and
  // the possibly new backups/.mindwrite directories, from child to parent.
  const unsyncedDirectories = new Set<string>();
  async function syncBackupDirectories(path: string, sessionId: string) {
    await policy(sessionId);
    const rootTarget = await ctx.fs.resolve(await workspace(sessionId));
    const root = ctx.fs.processPath(rootTarget);
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      const target = await ctx.fs.resolve(directory);
      if (
        ctx.fs.processPath(target) !== directory ||
        (directory !== root && !ctx.fs.contains(rootTarget, target))
      )
        throw new MindError('PATH', '备份目录位置已经改变');
      try {
        const handle = await open(
          directory,
          (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) |
            (constants.O_DIRECTORY ?? 0) |
            (constants.O_NOFOLLOW ?? 0),
        );
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        unsyncedDirectories.delete(directory);
      } catch (error) {
        if (!unsyncedDirectories.has(directory)) {
          ctx.logger.warn(
            `备份目录同步失败，无法保证断电持久。保存仍须通过备份读回校验。 ${directory} (${String(error)})`,
          );
          unsyncedDirectories.add(directory);
        }
      }
      if (directory === root) return;
    }
  }
  const disk = {
    prepare,
    write,
    backups: {
      workspacePath,
      fileKey,
      async identity(name: string, sessionId: string) {
        const path = await backupPath(sessionId, name);
        const info = await ctx.fs.stat(await ctx.fs.resolve(path));
        return info && JSON.stringify([path, info.version]);
      },
      async read(name: string, sessionId: string) {
        const path = await backupPath(sessionId, name);
        const target = await ctx.fs.resolve(path);
        const raw = await readRaw(target);
        if (raw !== undefined) await syncBackupDirectories(path, sessionId);
        return raw;
      },
      async write(name: string, text: string, previous: string | undefined, sessionId: string) {
        const path = await backupPath(sessionId, name);
        await write(path, text, previous, sessionId);
        await syncBackupDirectories(path, sessionId);
      },
    },
    async reviewKey(key: string, sessionId: string, documentId: string, kind: ReviewFileKind) {
      return internalPath(sessionId, `${kind}-${await fileKey(key, sessionId, documentId)}.json`);
    },
    async suggestionKeys(key: string, sessionId: string, documentId: string) {
      const cwd = await workspace(sessionId);
      const canonicalRoot = ctx.fs.processPath(await ctx.fs.resolve(cwd));
      const queue = (root: string) => {
        const path = relative(root, key).split(sep).join('/');
        return internalPath(
          sessionId,
          `suggestions-${token(JSON.stringify([path, documentId]))}.json`,
        );
      };
      // 0.7.2 and later can open a new queue at the canonical address on downgrade.
      const canonical = await queue(canonicalRoot);
      return cwd === canonicalRoot ? [canonical] : [...new Set([canonical, await queue(cwd)])];
    },
    async version(key: string) {
      const info = await ctx.fs.stat(await ctx.fs.resolve(key));
      return info ? JSON.stringify(info.version) : undefined;
    },
    async read(key: string) {
      return readRaw(await ctx.fs.resolve(key));
    },
  };
  const store = new DocumentStore(disk);
  async function workspace(sessionId: string) {
    const cached = requests.getStore()?.get(sessionId);
    if (cached) return cached;
    const pending = (async () => {
      const id = sessionId as SessionId;
      const live = ctx.sessions.get(id)?.header;
      if (!live && workspaces.has(sessionId)) return workspaces.get(sessionId)!;
      const header = live ?? (await ctx.sessionPersistence.stat(id))?.header;
      if (!header) throw new MindError('SESSION', '会话不存在');
      const cwd = header.cwd ?? ctx.sandboxPolicy.workspaceRoot;
      workspaces.delete(sessionId);
      workspaces.set(sessionId, cwd);
      if (workspaces.size > 100) workspaces.delete(workspaces.keys().next().value!);
      return cwd;
    })();
    requests.getStore()?.set(sessionId, pending);
    return pending;
  }
  async function resolve(sessionId: string, path: string) {
    const cwd = await workspace(sessionId);
    const root = await ctx.fs.resolve(cwd);
    const target = await ctx.fs.resolve(path, { cwd });
    if (!ctx.fs.contains(root, target) || ctx.fs.fileUrl(root) === ctx.fs.fileUrl(target)) {
      throw new MindError('PATH', '文件必须位于当前工作区内');
    }
    return ctx.fs.processPath(target);
  }
  async function internalPath(sessionId: string, name: string, backup = false) {
    const root = await ctx.fs.resolve(await workspace(sessionId));
    let parent = root;
    for (const part of backup ? ['.mindwrite', 'backups', name] : ['.mindwrite', name]) {
      const target = await ctx.fs.resolve(part, { cwd: ctx.fs.processPath(parent) });
      const expected = new URL(
        encodeURIComponent(part),
        ctx.fs.fileUrl(parent).replace(/\/?$/, '/'),
      ).href;
      if (!ctx.fs.contains(parent, target) || ctx.fs.fileUrl(target) !== expected)
        throw new MindError('PATH', '内部文件必须位于工作区的 .mindwrite 目录内');
      parent = target;
    }
    return ctx.fs.processPath(parent);
  }
  function sessionIndex(sessionId: string, legacy = false) {
    const name = `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    return legacy ? resolve(sessionId, '.mindwrite-' + name) : internalPath(sessionId, name);
  }
  async function currentPath(sessionId: string): Promise<string | undefined> {
    if (current.has(sessionId)) return current.get(sessionId);
    const text =
      (await disk.read(await sessionIndex(sessionId))) ??
      (await disk.read(await sessionIndex(sessionId, true)));
    if (text) {
      const value = z
        .object({ current: z.string() })
        .parse(JSON.parse(text.replace(/^\uFEFF/, '')));
      current.set(sessionId, value.current);
      return value.current;
    }
  }
  async function setCurrent(sessionId: string, path: string) {
    const index = await sessionIndex(sessionId);
    await store.serial(index, async () =>
      disk.write(
        index,
        JSON.stringify({ current: path }, null, 2) + '\n',
        await disk.read(index),
        sessionId,
      ),
    );
    // An explicit file selection has now saved the replacement index. Only
    // remove the exact legacy version we observe, with this session's policy.
    const root = await ctx.fs.resolve(await workspace(sessionId));
    const name = `.mindwrite-session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    const legacy = await ctx.fs.resolve(name, { cwd: ctx.fs.processPath(root) });
    const expectedUrl = new URL(name, ctx.fs.fileUrl(root).replace(/\/?$/, '/')).href;
    if (ctx.fs.fileUrl(legacy) === expectedUrl) {
      const info = await ctx.fs.stat(legacy);
      if (info?.type === 'file') {
        const old = await ctx.fs.readText(legacy);
        let record;
        try {
          record = JSON.parse(old);
        } catch {
          /* Preserve unrecognized legacy files. */
        }
        if (record && typeof record.current === 'string' && Object.keys(record).length === 1)
          await ctx.fs.deleteFile(
            legacy,
            { version: info.version },
            undefined,
            await policy(sessionId),
          );
      }
    }
    current.set(sessionId, path);
  }
  async function keyOf(sessionId: string, path?: string) {
    path ??= await currentPath(sessionId);
    if (!path || !isDocumentPath(path)) {
      throw new MindError('DOCUMENT', '请先新建或选择导图');
    }
    return { key: await resolve(sessionId, path), path };
  }
  async function files(sessionId: string) {
    const cwd = await workspace(sessionId);
    let inventory = inventories.get(cwd);
    if (!inventory) {
      inventory = { expires: 0 };
      inventories.set(cwd, inventory);
      if (inventories.size > 100) inventories.delete(inventories.keys().next().value!);
    }
    const entry = inventory;
    if (!entry.pending && Date.now() >= entry.expires) {
      entry.pending = readFiles(cwd)
        .then((value) => {
          entry.value = value;
          entry.expires = Date.now() + 2000;
          return value;
        })
        .finally(() => {
          entry.pending = undefined;
        });
      // The active document is always stat-checked by store.read. Other document
      // titles refresh asynchronously, so directory I/O cannot stall typing.
      void entry.pending.catch(() => {
        entry.expires = entry.value ? Date.now() + 2000 : 0;
      });
    }
    return entry.value ?? entry.pending!;
  }
  async function readFiles(cwd: string): Promise<FileList> {
    const root = await ctx.fs.resolve(cwd);
    const entries = (await ctx.fs.listDir(root)).filter(
      (f) => f.type === 'file' && isDocumentPath(f.name) && ctx.fs.contains(root, f.target),
    );
    return Promise.all(
      entries.map(async (entry) => {
        // rc.3 listDir already supplies canonical targets and observed versions.
        const key = ctx.fs.processPath(entry.target);
        const version = JSON.stringify(entry.version ?? (await ctx.fs.stat(entry.target))?.version);
        let title = titles.get(key)?.version === version ? titles.get(key)?.title : undefined;
        if (!title) {
          try {
            title = (await store.read(key)).document.root.title;
          } catch {
            title = entry.name.replace(/(?:\.(?:导图|mindmap|mindwrite|json))+$/i, '');
          }
          titles.set(key, { version, title });
        }
        return { path: entry.name, title };
      }),
    );
  }
  async function create(
    sessionId: string,
    title: string,
    filename: string | undefined,
    children: NodeInput[],
    type = inferDocumentType(title, children),
  ) {
    if (store.scopes.has(sessionId)) throw new MindError('SCOPE_VIOLATION', '选区操作不能新建导图');
    const path = documentFilename(filename ?? title);
    const s = await store.create(
      await resolve(sessionId, path),
      title,
      children,
      sessionId,
      typeDefaults(type),
    );
    await setCurrent(sessionId, path);
    await invalidateFiles(sessionId);
    return snapshotView(s, path);
  }
  async function importFile(sessionId: string, filename: string, result: ImportResult) {
    if (store.scopes.has(sessionId)) throw new MindError('SCOPE_VIOLATION', '选区操作不能导入文稿');
    for (let attempt = 1; attempt <= 10000; attempt++) {
      const suffix = (attempt === 1 ? '' : '-' + attempt) + '.导图.json';
      const path = cleanFilename(filename, MAX_FILENAME_BYTES - Buffer.byteLength(suffix)) + suffix;
      let snapshot;
      try {
        snapshot = await store.import(
          await resolve(sessionId, path),
          result.root,
          result.report,
          sessionId,
          { documentType: result.documentType, numberingScheme: result.numberingScheme },
          result.importNumbering,
        );
      } catch (error) {
        if ((error as MindError).code === 'EXISTS') continue;
        throw error;
      }
      await setCurrent(sessionId, path);
      await invalidateFiles(sessionId);
      const view = snapshotView(snapshot, path);
      if (view.importSummary?.excerpts) {
        const wanted = new Set(result.importNumbering?.warnings?.map((w) => w.paragraph));
        for (const p of result.paragraphs)
          if (wanted.has(p.paragraph))
            view.importSummary.excerpts[p.paragraph] = p.text.slice(0, 240);
      }
      return { ...view, detection: result.detection };
    }
    throw new MindError('EXISTS', '同名文稿过多，请更改名称后重试');
  }
  async function exportFile(
    sessionId: string,
    title: string,
    format: 'docx' | 'md',
    bytes: Buffer,
  ) {
    return saveUniqueExport(title, format, async (filename) => {
      const sandboxPolicy = await policy(sessionId);
      const target = await ctx.fs.resolve(await resolve(sessionId, filename));
      try {
        if (format === 'md')
          await ctx.fs.writeText(
            target,
            bytes.toString('utf8'),
            { kind: 'createIfAbsent' },
            undefined,
            sandboxPolicy,
          );
        else await writeBinaryExclusive(ctx, target, bytes, sandboxPolicy);
        return true;
      } catch (error) {
        if (
          ['EEXIST', 'FS_ALREADY_EXISTS', 'FS_NOT_OBSERVED'].includes(
            (error as { code?: string }).code ?? '',
          )
        )
          return false;
        throw error;
      }
    });
  }
  return {
    store,
    workspace,
    forgetWorkspace,
    resolve,
    currentPath,
    setCurrent,
    keyOf,
    files,
    invalidateFiles,
    create,
    importFile,
    exportFile,
    withSession,
    withRequest,
    grantScopeWrites,
  };
}
export type Files = ReturnType<typeof createFiles>;
