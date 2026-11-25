import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeHostPort } from './node-host.js';
import { KnowledgeBase } from '../core/kb/index.js';

export function knowledgeBasesRoot(): string {
  if (process.env.SEAL_VAULTS_ROOT) return path.resolve(process.env.SEAL_VAULTS_ROOT);
  return path.resolve(process.env.SEAL_HOME ?? path.join(os.homedir(), '.seal'), 'vaults');
}

export function assertKnowledgeBaseTree(root = knowledgeBasesRoot()): void {
  let parent = path.parse(path.resolve(root)).root;
  for (const part of path.resolve(root).slice(parent.length).split(path.sep)) {
    parent = path.join(parent, part);
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('知识库路径不能经过符号链接');
  }
  const visit = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name), info = fs.lstatSync(full);
      if (info.isSymbolicLink() || !info.isDirectory() && info.nlink > 1) throw new Error('知识库不能包含符号链接或硬链接文件');
      if (info.isDirectory()) visit(full);
    }
  };
  visit(root);
}

export function knowledgeBase(root = knowledgeBasesRoot()): KnowledgeBase {
  assertKnowledgeBaseTree(root);
  return new KnowledgeBase(new NodeHostPort(), root);
}

const queues = new Map<string, Promise<unknown>>();
export async function serializedKnowledgeBase<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root), previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}
