import fs from 'node:fs';
import path from 'node:path';
import type { HostPort } from '../core/host.js';
import type { IngestMaterialItem, IngestSkippedItem } from '../core/kb/ingest.js';
import { assertOutputIsolation } from './output-isolation.js';

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.wmf': 'image/x-wmf',
  '.emf': 'image/x-emf',
  '.webp': 'image/webp',
};

interface DiscoveredFile {
  path: string;
  origin: 'explicit' | 'directory';
}

export interface PreparedKbIngest {
  items: IngestMaterialItem[];
  skipped: IngestSkippedItem[];
  expandedPaths: string[];
}

function collectDirectoryFiles(
  rootDir: string,
  visitedRealDirs: Set<string>,
  collected: string[],
  skipped: IngestSkippedItem[],
): void {
  const real = fs.realpathSync(rootDir);
  if (visitedRealDirs.has(real)) return;
  visitedRealDirs.add(real);

  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(rootDir, entry.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      skipped.push({ source: full, reason: '无法读取文件状态（可能为失效符号链接）' });
      continue;
    }
    if (st.isDirectory()) {
      collectDirectoryFiles(full, visitedRealDirs, collected, skipped);
    } else if (st.isFile()) {
      collected.push(full);
    } else {
      skipped.push({ source: full, reason: '非普通文件，已跳过' });
    }
  }
}

/** Expand file/directory inputs safely, enforce vault isolation, and convert legacy formats in stagingRoot. */
export async function prepareKbIngestInputs(input: {
  host: HostPort;
  vaultRoot: string;
  rawPaths: readonly string[];
  stagingRoot: string;
}): Promise<PreparedKbIngest> {
  if (!input.rawPaths.length) {
    throw new Error('请至少提供一个文件或目录路径');
  }

  const discovered: DiscoveredFile[] = [];
  const expandedDirs: string[] = [];
  const skipped: IngestSkippedItem[] = [];
  const visitedRealDirs = new Set<string>();

  for (const rawPath of input.rawPaths) {
    const resolved = path.resolve(rawPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`入库路径不存在：${rawPath}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      expandedDirs.push(resolved);
      const dirFiles: string[] = [];
      collectDirectoryFiles(resolved, visitedRealDirs, dirFiles, skipped);
      dirFiles.sort((a, b) => a.localeCompare(b));
      for (const file of dirFiles) {
        discovered.push({ path: file, origin: 'directory' });
      }
    } else if (stat.isFile()) {
      discovered.push({ path: resolved, origin: 'explicit' });
    } else {
      throw new Error(`入库路径不是普通文件或目录：${rawPath}`);
    }
  }

  assertOutputIsolation(
    { directories: [input.vaultRoot] },
    {
      files: discovered.map((item) => item.path),
      directories: expandedDirs,
    },
  );

  const items: IngestMaterialItem[] = [];
  let stageCounter = 0;

  for (const entry of discovered) {
    const ext = path.extname(entry.path).toLowerCase();
    if (ext === '.docx') {
      items.push({ kind: 'docx', sourcePath: entry.path, originalPath: entry.path });
    } else if (ext === '.doc') {
      if (!input.host.convertDocToDocx) {
        throw new Error('宿主不支持将 DOC 转换为 DOCX');
      }
      stageCounter++;
      const converted = await input.host.convertDocToDocx(
        entry.path,
        path.join(input.stagingRoot, `doc-${stageCounter}`),
      );
      items.push({ kind: 'docx', sourcePath: converted, originalPath: entry.path });
    } else if (ext === '.pdf') {
      items.push({ kind: 'pdf', sourcePath: entry.path, originalPath: entry.path });
    } else if (ext in IMAGE_MIME_BY_EXTENSION) {
      items.push({
        kind: 'image',
        sourcePath: entry.path,
        originalPath: entry.path,
        mime: IMAGE_MIME_BY_EXTENSION[ext],
      });
    } else if (ext === '.xlsx') {
      items.push({ kind: 'xlsx', sourcePath: entry.path, originalPath: entry.path });
    } else if (ext === '.xls' || ext === '.ods') {
      if (!input.host.convertSpreadsheetToXlsx) {
        throw new Error('宿主不支持将 XLS/ODS 转换为 XLSX');
      }
      stageCounter++;
      const converted = await input.host.convertSpreadsheetToXlsx(
        entry.path,
        path.join(input.stagingRoot, `sheet-${stageCounter}`),
      );
      items.push({ kind: 'xlsx', sourcePath: converted, originalPath: entry.path });
    } else if (ext === '.csv') {
      items.push({ kind: 'delimited', sourcePath: entry.path, originalPath: entry.path, delimiter: ',' });
    } else if (ext === '.tsv') {
      items.push({ kind: 'delimited', sourcePath: entry.path, originalPath: entry.path, delimiter: '\t' });
    } else if (ext === '.txt' || ext === '.md') {
      items.push({ kind: 'text', sourcePath: entry.path, originalPath: entry.path });
    } else if (entry.origin === 'explicit') {
      throw new Error(`不支持的入库文件格式：${entry.path}`);
    } else {
      skipped.push({
        source: entry.path,
        reason: `不支持的文件格式：${ext || '无扩展名'}`,
      });
    }
  }

  if (!items.length) {
    const detail = skipped.length
      ? `（已跳过 ${skipped.length} 项：${skipped
          .slice(0, 5)
          .map((s) => `${path.basename(s.source)}: ${s.reason}`)
          .join('；')}）`
      : '';
    throw new Error(`未找到受支持的可入库材料${detail}`);
  }

  return {
    items,
    skipped,
    expandedPaths: discovered.map((entry) => entry.path),
  };
}
