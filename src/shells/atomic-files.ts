import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, rename, unlink, writeFile } from 'node:fs/promises';
import type { FileWrite } from '../core/host.js';

type Rename = typeof rename;

export async function writeFileBatch(files: readonly FileWrite[], move: Rename = rename): Promise<void> {
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('批次包含重复文件');
  const token = randomBytes(12).toString('hex');
  const staged: Array<{ file: FileWrite; stage: string; backup: string | null; committed: boolean; preserveBackup: boolean }> = [];
  try {
    for (const file of files) {
      const stage = `${file.path}.${token}.stage`, backupPath = `${file.path}.${token}.before`;
      let exists = false;
      try {
        const stat = await lstat(file.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('目标不是普通文件');
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (exists && file.createOnly) throw new Error('目标文件已存在');
      const item = { file, stage, backup: null as string | null, committed: false, preserveBackup: false };
      staged.push(item);
      await writeFile(stage, file.data, { flag: 'wx' });
      if (exists) {
        item.backup = backupPath;
        await copyFile(file.path, backupPath, constants.COPYFILE_EXCL);
      }
    }
    for (const item of staged) {
      if (item.file.createOnly) {
        await link(item.stage, item.file.path);
        item.committed = true;
        await unlink(item.stage);
      } else {
        await move(item.stage, item.file.path);
        item.committed = true;
      }
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const item of [...staged].reverse()) if (item.committed) {
      try {
        if (item.backup) await move(item.backup, item.file.path);
        else await unlink(item.file.path);
      } catch (rollbackError) { item.preserveBackup = true; failures.push(rollbackError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], '文件批次失败且回滚未完成');
    throw error;
  } finally {
    for (const item of staged) {
      await unlink(item.stage).catch(() => {});
      if (item.backup && !item.preserveBackup) await unlink(item.backup).catch(() => {});
    }
  }
}
