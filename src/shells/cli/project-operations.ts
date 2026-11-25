import path from "node:path";
import fs from "node:fs/promises";

const queues = new Map<string, Promise<unknown>>();
/** Tools and owner UI share this queue for a physical project. */
export async function serializedProject<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await physicalPath(path.resolve(root)),
    previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

async function physicalPath(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(root);
    if (parent === root) throw error;
    return path.join(await physicalPath(parent), path.basename(root));
  }
}
