import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

export interface DependencyViolation { file: string; line: number; specifier: string; reason: string }
type Layer = 'core' | 'workbench' | 'shells';
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
// New pure-layer library entries require review of their runtime and transitive host dependencies.
const pureJavaScriptPackages = new Set(['saxes', 'marked', 'jpeg-js']);

function layerAt(root: string, file: string): Layer | null {
  const segments = path.relative(root, file).split(path.sep);
  if (segments[0] !== 'src') return null;
  return segments[1] === 'core' || segments[1] === 'workbench' || segments[1] === 'shells' ? segments[1] : null;
}

function compilerOptions(root: string): ts.CompilerOptions {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  return parsed.options;
}

function hostPackage(file: string): boolean {
  const segments = file.split(path.sep);
  return segments.some((segment, index) => segment === 'node_modules' && segments[index + 1] === '@deepseek-ai');
}

function installedPackageName(file: string): string | undefined {
  const segments = file.split(path.sep);
  const index = segments.lastIndexOf('node_modules');
  if (index < 0) return undefined;
  const scoped = segments[index + 1]?.startsWith('@') === true;
  const manifest = path.join(segments.slice(0, index + (scoped ? 3 : 2)).join(path.sep), 'package.json');
  if (!fs.existsSync(manifest)) return undefined;
  const value: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string' ? value.name : undefined;
}

function staticText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function requireReference(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'require';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'require';
  return ts.isElementAccessExpression(node) && staticText(node.argumentExpression) === 'require';
}

function requireResolve(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node) && node.name.text === 'resolve' && requireReference(node.expression)) ||
    (ts.isElementAccessExpression(node) && staticText(node.argumentExpression) === 'resolve' && requireReference(node.expression));
}

/** AST syntax and physical module resolution enforce the same policy for sources and fixtures. */
export function dependencyViolations(root: string, files: string[], options = compilerOptions(root)): DependencyViolation[] {
  root = fs.realpathSync(root);
  const violations: DependencyViolation[] = [];
  const program = ts.createProgram(files.map(file => path.resolve(root, file)), { ...options, noResolve: true, noLib: true, types: [], allowJs: true });
  const checker = program.getTypeChecker();
  for (const input of files) {
    const file = path.resolve(root, input);
    const origin = layerAt(root, file);
    if (origin === null) {
      violations.push({ file: path.relative(root, file), line: 1, specifier: '<source>', reason: 'Source is outside the three declared layers' });
      continue;
    }
    const physicalOrigin = layerAt(root, fs.realpathSync(file));
    if (physicalOrigin !== origin) {
      violations.push({ file: path.relative(root, file), line: 1, specifier: '<source symlink>', reason: 'Source resolves outside its declared layer' });
      continue;
    }
    if (origin === 'shells') continue;
    const source = program.getSourceFile(file) ?? ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const report = (node: ts.Node, specifier: string, reason: string) => violations.push({ file: path.relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, specifier, reason });
    const dependency = (node: ts.Node, argument: ts.Node | undefined) => {
      if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
        report(node, '<dynamic>', 'Module target must be a statically resolvable literal'); return;
      }
      const specifier = argument.text;
      if (/^(?:node:|@deepseek-ai\/)/.test(specifier) || builtins.has(specifier)) {
        report(node, specifier, 'Host dependency is forbidden'); return;
      }
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!resolved) {
        report(node, specifier, 'Module target cannot be resolved'); return;
      }
      const physicalTarget = fs.realpathSync(resolved.resolvedFileName);
      if (hostPackage(physicalTarget)) {
        report(node, specifier, 'Resolved host package is forbidden'); return;
      }
      const destination = layerAt(root, physicalTarget);
      const allowed = destination === 'core' || (origin === 'workbench' && destination === 'workbench');
      if (allowed) return;
      const installedDependency = resolved.resolvedFileName.split(path.sep).includes('node_modules') && physicalTarget.split(path.sep).includes('node_modules');
      const packageName = installedDependency ? installedPackageName(physicalTarget) : undefined;
      const approvedEntry = packageName !== undefined && pureJavaScriptPackages.has(packageName)
        ? ts.resolveModuleName(packageName, file, options, ts.sys).resolvedModule : undefined;
      if (destination === null && approvedEntry !== undefined && fs.realpathSync(approvedEntry.resolvedFileName) === physicalTarget) return;
      report(node, specifier, `Forbidden resolved target: ${path.relative(root, physicalTarget)}`);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) dependency(node, node.moduleSpecifier);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) dependency(node, node.moduleReference.expression);
      else if (ts.isImportTypeNode(node)) dependency(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || requireReference(node.expression) || requireResolve(node.expression))) dependency(node, node.arguments[0]);
      else if (requireReference(node)) {
        const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        const resolveCall = requireResolve(node.parent) && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent;
        const propertyName = ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        if (!directCall && !resolveCall && !propertyName) report(node, '<require reference>', 'Aliased or computed module loader is forbidden');
      }
      const localModule = ts.isIdentifier(node) && node.text === 'module' && checker.getSymbolAtLocation(node)?.declarations?.some(declaration =>
        declaration.getSourceFile() === source && !source.isDeclarationFile && !ts.findAncestor(declaration, ancestor =>
          ts.canHaveModifiers(ancestor) && ts.getModifiers(ancestor)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true));
      if (ts.isIdentifier(node) && node.text === 'module' && !localModule) {
        const member = node.parent;
        const knownRequire = (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) && member.expression === node && requireReference(member);
        const propertyName = ts.isPropertyAccessExpression(member) && member.name === node;
        if (!knownRequire && !propertyName) report(node, '<module reference>', 'Aliased or computed module loader is forbidden');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    for (const error of diagnostics) report(source, '<invalid syntax>', ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  return violations;
}
