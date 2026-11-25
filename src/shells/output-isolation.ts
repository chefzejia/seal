import fs from "node:fs";
import path from "node:path";

interface Paths { files?: string[]; directories?: string[] }

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function canonical(file: string): string {
  const resolved = path.resolve(file);
  let parent = resolved;
  while (!exists(parent)) parent = path.dirname(parent);
  return path.resolve(fs.realpathSync(parent), path.relative(parent, resolved));
}

function within(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function identity(file: string): string | null {
  if (!exists(file)) return null;
  const stat = fs.statSync(file);
  return `${stat.dev}:${stat.ino}`;
}

function existingFiles(directory: string): string[] {
  const files: string[] = [], visited = new Set<string>();
  const visit = (entry: string) => {
    const stat = fs.statSync(entry);
    if (!stat.isDirectory()) { files.push(entry); return; }
    const real = fs.realpathSync(entry);
    if (visited.has(real)) return;
    visited.add(real);
    for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
  };
  if (exists(directory)) visit(directory);
  return files;
}

/** Preflight the complete write set, including sidecars, before creating any output. */
export function assertOutputIsolation(outputs: Paths, inputs: Paths): void {
  const protectedDirectories = (inputs.directories || []).map(canonical);
  const protectedFiles = [...(inputs.files || []), ...(inputs.directories || []).flatMap(existingFiles)];
  const protectedPaths = new Set(protectedFiles.map(canonical));
  const protectedIdentities = new Set(protectedFiles.map(identity).filter(value => value !== null));
  const reject = (file: string): never => { throw new Error(`Output must not overwrite any input template, patch, media or knowledge vault: ${file}`); };
  const check = (file: string) => {
    const resolved = canonical(file), physical = identity(file);
    if (protectedPaths.has(resolved) || protectedDirectories.some(directory => within(resolved, directory)) ||
        (physical !== null && protectedIdentities.has(physical))) reject(file);
  };
  const outputPaths = new Set<string>(), outputIdentities = new Set<string>();
  for (const file of outputs.files || []) {
    check(file);
    const resolved = canonical(file), physical = identity(file);
    if (outputPaths.has(resolved) || (physical !== null && outputIdentities.has(physical))) throw new Error(`Output files must be distinct: ${file}`);
    outputPaths.add(resolved); if (physical !== null) outputIdentities.add(physical);
  }
  for (const directory of outputs.directories || []) {
    const resolved = canonical(directory);
    if ([...protectedPaths].some(file => within(file, resolved)) || protectedDirectories.some(input => within(input, resolved) || within(resolved, input))) reject(directory);
    existingFiles(directory).forEach(check);
  }
}
