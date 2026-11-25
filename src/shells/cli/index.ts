import { pathToFileURL } from 'node:url';
import { NodeHostPort } from '../node-host.js';
import { runProject } from './project-v2.js';
import { kbHelpText, runKnowledgeBase } from './kb.js';

const HELP_FLAGS = new Set(['--help', '-h', 'help']);
const PROJECT_COMMANDS = new Set(['read', 'extract', 'edit', 'check', 'requirements']);
const KB_COMMANDS = new Set(['init', 'search', 'get', 'save', 'ingest', 'health']);

export function cliHelpText(): string {
  return [
    'Seal 命令行用法:',
    '  seal project init --root <项目目录> --name <名称> --deadline <YYYY-MM-DD> [--vault <知识库ID>] --tender <文件>...',
    '  seal read --project <目录> --file <分册或路径> --mode <outline|blocks|search> [--from <地址>] [--query <关键词>] [--limit <N>] [--max-chars <N>] [--cursor <JSON>]',
    '  seal extract --project <目录> --tender <副本路径> --draft <分册名> --ranges <JSON区间数组>',
    '  seal edit --project <目录> --draft <分册名> --ops <JSON操作数组>',
    '  seal check --project <目录> [--draft <分册名>] [--group <代码>] [--offset <N>] [--limit <N>]',
    '  seal requirements --project <目录> --action <get|save|check> [--items <JSON数组>] [--offset <N>] [--limit <N>]',
    '  seal kb <init|search|get|save|ingest|health> [选项...]',
    '  seal --help | -h | help',
    '  seal kb --help | -h | help',
  ].join('\n');
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command && HELP_FLAGS.has(command)) {
    console.log(cliHelpText());
    return;
  }
  const host = new NodeHostPort();
  if (command === 'project') {
    if (rest[0] && (HELP_FLAGS.has(rest[0]) || (rest[0] === 'init' && (rest.includes('--help') || rest.includes('-h'))))) {
      console.log(cliHelpText());
      return;
    }
    if (rest[0] === 'init') {
      console.log(JSON.stringify(await runProject(host, rest), null, 2));
      return;
    }
  }
  if (command && PROJECT_COMMANDS.has(command)) {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(cliHelpText());
      return;
    }
    console.log(JSON.stringify(await runProject(host, [command, ...rest]), null, 2));
    return;
  }
  if (command === 'kb') {
    if ((rest[0] && HELP_FLAGS.has(rest[0])) || (rest[0] && KB_COMMANDS.has(rest[0]) && (rest.includes('--help') || rest.includes('-h')))) {
      console.log(kbHelpText());
      return;
    }
    console.log(JSON.stringify(await runKnowledgeBase(host, rest), null, 2));
    return;
  }
  throw new Error('支持的命令：project init、read、extract、edit、check、requirements、kb search|get|save|ingest');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
