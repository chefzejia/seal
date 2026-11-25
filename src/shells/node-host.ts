import fs from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { decode as decodeBmp } from "bmp-ts";
import type {
  ConvertedImage,
  ExtractedPdfPage,
  ExtractedPdfResult,
  FileStat,
  FileWrite,
  HostPort,
} from "../core/host.js";
import { validateImageBytes } from "../core/docx/zip.js";
import { assertOutputIsolation } from "./output-isolation.js";
import { writeFileBatch } from "./atomic-files.js";
import {
  extractPdfBytesPageTexts,
  extractPdfWithPdfium,
  renderPdfBytesToPngs,
} from "./pdf-engine.js";

export class NodeHostPort implements HostPort {
  async writeFiles(files: readonly FileWrite[]): Promise<void> { await writeFileBatch(files); }

  async authorizationKey(create: boolean): Promise<Uint8Array | null> {
    const directory = path.join(process.env.SEAL_HOME ?? path.join(homedir(), '.seal'), 'keys');
    const file = path.join(directory, 'authorization.key');
    if (create) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('授权密钥不是普通文件');
      const key = fs.readFileSync(file);
      if (key.length < 32) throw new Error('授权密钥长度不足');
      return key;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async ledgerAnchorPath(projectRoot: string, create: boolean): Promise<string> {
    const directory = path.join(process.env.SEAL_HOME ?? path.join(homedir(), '.seal'), 'ledgers');
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, `${createHash('sha256').update(path.resolve(projectRoot)).digest('hex')}.json`);
  }
  async readBytes(filePath: string): Promise<Uint8Array> {
    return new Uint8Array(fs.readFileSync(filePath));
  }

  async writeBytes(filePath: string, data: Uint8Array): Promise<void> {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, data);
  }

  async readText(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, "utf-8");
  }

  async writeText(filePath: string, content: string): Promise<void> {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  }

  async stat(filePath: string): Promise<FileStat> {
    if (!fs.existsSync(filePath)) {
      return { exists: false, size: 0, isDirectory: false };
    }
    const st = fs.statSync(filePath);
    return {
      exists: true,
      size: st.size,
      isDirectory: st.isDirectory(),
    };
  }

  async removeDirectory(dirPath: string): Promise<void> { fs.rmSync(dirPath, { recursive: true, force: true }); }

  async removeFile(filePath: string): Promise<void> { fs.unlinkSync(filePath); }

  async makeDirectory(dirPath: string): Promise<void> { fs.mkdirSync(dirPath, { recursive: true }); }

  async renderDocxPages(docxPath: string, outDir: string): Promise<string[]> {
    const input = path.resolve(docxPath), directory = path.resolve(outDir);
    assertOutputIsolation({ directories: [directory] }, { files: [input] });
    fs.mkdirSync(directory, { recursive: true });
    const profile = fs.mkdtempSync(path.join(tmpdir(), 'seal-render-'));
    try {
      execFileSync(findSofficeBinary(), [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, input], { stdio: 'pipe', timeout: 60000 });
      const pdf = path.join(directory, `${path.basename(input, path.extname(input))}.pdf`);
      if (!fs.existsSync(pdf) || !fs.statSync(pdf).size) throw new Error('LibreOffice 未生成预览 PDF');
      if (isPopplerPdfEngine() || Boolean(process.env.SEAL_PDFTOPPM)) {
        execFileSync(findPopplerBinary('pdftoppm', 'SEAL_PDFTOPPM'), ['-png', '-r', '110', pdf, path.join(directory, 'page')], { stdio: 'pipe', timeout: 60000 });
        const pages = fs.readdirSync(directory).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!pages.length) throw new Error('Poppler 未生成预览页');
        for (const page of pages) await sharp(fs.readFileSync(path.join(directory, page)), { failOn: 'warning' }).metadata();
        return pages.map(page => path.join(directory, page));
      }
      const rendered = await renderPdfBytesToPngs(new Uint8Array(fs.readFileSync(pdf)), directory, { dpi: 110 });
      if (!rendered.length) throw new Error('PDF 引擎未生成预览页');
      for (const page of rendered) await sharp(fs.readFileSync(page), { failOn: 'warning' }).metadata();
      return rendered;
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  }

  async extractDocxPageTexts(docxBytes: Uint8Array): Promise<string[]> {
    const workDir = fs.mkdtempSync(path.join(tmpdir(), 'seal-toc-pages-'));
    try {
      const input = path.join(workDir, 'doc.docx');
      const profile = path.join(workDir, 'profile');
      const outDir = path.join(workDir, 'out');
      fs.writeFileSync(input, docxBytes);
      fs.mkdirSync(profile, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      const fontconfigFile = process.env.FONTCONFIG_FILE ?? process.env.SEAL_FONTCONFIG_FILE;
      const env = fontconfigFile ? { ...process.env, FONTCONFIG_FILE: fontconfigFile } : process.env;
      execFileSync(
        findSofficeBinary(),
        [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, input],
        { stdio: 'pipe', timeout: 90000, env },
      );
      const pdf = path.join(outDir, 'doc.pdf');
      if (!fs.existsSync(pdf) || !fs.statSync(pdf).size) return [];
      if (isPopplerPdfEngine() || Boolean(process.env.SEAL_PDFTOTEXT)) {
        const textStdout = execFileSync(
          findPopplerBinary('pdftotext', 'SEAL_PDFTOTEXT'),
          [pdf, '-'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
        );
        const pages = textStdout.replace(/\r\n?/g, '\n').split('\f');
        if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
        return pages;
      }
      return await extractPdfBytesPageTexts(new Uint8Array(fs.readFileSync(pdf)));
    } catch {
      return [];
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  async extractPdf(
    inputPath: string,
    outDir: string,
    options?: { dpi?: number; maxPages?: number },
  ): Promise<ExtractedPdfResult> {
    const input = path.resolve(inputPath);
    const directory = path.resolve(outDir);
    assertOutputIsolation({ directories: [directory] }, { files: [input] });
    const dpi = options?.dpi ?? 150;
    const maxPages = options?.maxPages ?? 120;
    if (!Number.isInteger(dpi) || dpi < 36 || dpi > 600) {
      throw new Error('PDF 渲染 DPI 参数无效');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error('PDF 最大渲染页数参数无效');
    }
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
      throw new Error(`PDF 文件不存在或不是普通文件：${inputPath}`);
    }
    const usePoppler =
      isPopplerPdfEngine() ||
      Boolean(process.env.SEAL_PDFINFO || process.env.SEAL_PDFTOTEXT || process.env.SEAL_PDFTOPPM);
    if (!usePoppler) {
      const pdfBytes = new Uint8Array(fs.readFileSync(input));
      return extractPdfWithPdfium(pdfBytes, directory, { dpi, maxPages });
    }
    let infoStdout = '';
    try {
      infoStdout = execFileSync(findPopplerBinary('pdfinfo', 'SEAL_PDFINFO'), [input], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法解析 PDF 元数据（可能文件已损坏或非有效 PDF）：${detail}`);
    }
    const pagesMatch = /^Pages:\s*(\d+)\s*$/m.exec(infoStdout);
    if (!pagesMatch) {
      throw new Error('无法从 pdfinfo 输出读取 PDF 页数');
    }
    const pageCount = Number(pagesMatch[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error('PDF 页数无效');
    }
    let textStdout = '';
    try {
      textStdout = execFileSync(
        findPopplerBinary('pdftotext', 'SEAL_PDFTOTEXT'),
        ['-f', '1', '-l', String(pageCount), input, '-'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`PDF 文本层提取失败：${detail}`);
    }
    const normalizedText = textStdout.replace(/\r\n?/g, '\n');
    const rawParts = normalizedText.split('\f');
    const pageTexts =
      rawParts.length > pageCount && rawParts[rawParts.length - 1] === ''
        ? rawParts.slice(0, pageCount)
        : rawParts.slice(0, pageCount);
    while (pageTexts.length < pageCount) pageTexts.push('');

    const renderedPages = Math.min(pageCount, maxPages);
    const truncatedPages = Math.max(0, pageCount - renderedPages);
    fs.mkdirSync(directory, { recursive: true });
    if (renderedPages > 0) {
      try {
        execFileSync(
          findPopplerBinary('pdftoppm', 'SEAL_PDFTOPPM'),
          ['-png', '-r', String(dpi), '-f', '1', '-l', String(renderedPages), input, path.join(directory, 'page')],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`PDF 页面光栅化失败：${detail}`);
      }
    }
    const imageByPage = new Map<number, string>();
    for (const fileName of fs.readdirSync(directory)) {
      const match = /^page-(\d+)\.png$/.exec(fileName);
      if (!match) continue;
      const pageNumber = Number(match[1]);
      if (pageNumber >= 1 && pageNumber <= renderedPages) {
        const fullPath = path.join(directory, fileName);
        const metadata = await sharp(fs.readFileSync(fullPath), { failOn: 'warning' }).metadata();
        if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
          throw new Error(`PDF 第 ${pageNumber} 页渲染 PNG 无效`);
        }
        imageByPage.set(pageNumber, fullPath);
      }
    }
    if (imageByPage.size !== renderedPages) {
      throw new Error(`PDF 渲染页数不完整：预期 ${renderedPages} 页，实际生成 ${imageByPage.size} 页`);
    }
    const pages: ExtractedPdfPage[] = [];
    for (let page = 1; page <= pageCount; page++) {
      const imagePath = imageByPage.get(page);
      pages.push({
        page,
        text: pageTexts[page - 1] ?? '',
        ...(imagePath ? { imagePath } : {}),
      });
    }
    return { pageCount, renderedPages, truncatedPages, pages };
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const root = path.resolve(dirPath);
    const results: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          // Always return POSIX-normalized path relative to dirPath!
          const rel = path.relative(root, full).split(path.sep).join("/");
          results.push(rel);
        }
      }
    };
    walk(root);
    return results;
  }

  async convertDocToDocx(inputPath: string, outDir: string): Promise<string> {
    const input = path.resolve(inputPath), directory = path.resolve(outDir);
    const output = path.join(directory, `${path.basename(input, path.extname(input))}.docx`);
    assertOutputIsolation({ files: [output] }, { files: [input] });
    if (fs.existsSync(output)) throw new Error('DOC 转换目标已存在');
    fs.mkdirSync(directory, { recursive: true });
    const profile = fs.mkdtempSync(path.join(tmpdir(), 'seal-doc-'));
    try {
      execFileSync(findSofficeBinary(), [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx', '--outdir', directory, input], { stdio: 'pipe', timeout: 60000 });
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('LibreOffice 未生成 DOCX');
      return output;
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }

  async convertSpreadsheetToXlsx(inputPath: string, outDir: string): Promise<string> {
    const input = path.resolve(inputPath);
    const directory = path.resolve(outDir);
    const output = path.join(directory, `${path.basename(input, path.extname(input))}.xlsx`);
    assertOutputIsolation({ files: [output] }, { files: [input] });
    if (fs.existsSync(output)) throw new Error('表格转换目标已存在');
    fs.mkdirSync(directory, { recursive: true });
    const profile = fs.mkdtempSync(path.join(tmpdir(), 'seal-sheet-'));
    try {
      execFileSync(
        findSofficeBinary(),
        [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'xlsx', '--outdir', directory, input],
        { stdio: 'pipe', timeout: 60000 },
      );
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
        throw new Error('LibreOffice 未生成 XLSX');
      }
      return output;
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }

  async convertImageBytesToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
    await this.validateImage(bytes, mime);
    const output = await sharp(bytes, { failOn: 'warning', page: 0 }).png().toBuffer();
    const metadata = await sharp(output, { failOn: 'warning' }).metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
      throw new Error('图片转换为 PNG 失败');
    }
    return new Uint8Array(output);
  }

  async convertImageToPng(inputPath: string, outDir: string): Promise<ConvertedImage> {
    const input = path.resolve(inputPath), directory = path.resolve(outDir);
    const output = path.join(directory, path.basename(input, path.extname(input)) + '.png');
    const dimensions = path.join(directory, 'dimensions.txt');
    const profile = path.join(directory, 'profile'), basic = path.join(profile, 'user/basic');
    assertOutputIsolation({ files: [output, dimensions], directories: [profile] }, { files: [input] });
    if (fs.existsSync(output)) throw new Error('Image preview output already exists');
    fs.mkdirSync(directory, { recursive: true });
    const soffice = findSofficeBinary(), environment = `-env:UserInstallation=${pathToFileURL(profile).href}`;
    if (!fs.existsSync(path.join(profile, 'user/registrymodifications.xcu'))) execFileSync(soffice, [environment, '--headless', '--terminate_after_init'], { stdio: 'pipe', timeout: 60000 });
    fs.mkdirSync(path.join(basic, 'Standard'), { recursive: true });
    const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const declaration = (kind: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ${kind} PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "${kind === 'script:module' ? 'module' : kind === 'library:library' ? 'library' : 'libraries'}.dtd">\n`;
    fs.writeFileSync(path.join(basic, 'script.xlc'), declaration('library:libraries') + '<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink"><library:library library:name="Standard" library:link="false"/></library:libraries>');
    fs.writeFileSync(path.join(basic, 'Standard/script.xlb'), declaration('library:library') + '<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false"><library:element library:name="SealGraphics"/></library:library>');
    // Export exact graphic bounds; raster images without a physical size use measured pixels at 96 DPI.
    const macro = `Sub ConvertImage
On Error GoTo Failed
Dim provider As Object, graphic As Object, bounds As Variant, raster As Variant, scale As Double
Dim drawing As Object, shape As Object, exporter As Object
Dim options(0) As New com.sun.star.beans.PropertyValue
Dim source(0) As New com.sun.star.beans.PropertyValue
Dim target(2) As New com.sun.star.beans.PropertyValue
Dim pixels(1) As New com.sun.star.beans.PropertyValue
provider = CreateUnoService("com.sun.star.graphic.GraphicProvider")
source(0).Name = "URL"
source(0).Value = "${pathToFileURL(input).href}"
graphic = provider.queryGraphic(source())
bounds = graphic.Size100thMM
If bounds.Width <= 0 Or bounds.Height <= 0 Then
raster = graphic.SizePixel
If raster.Width <= 0 Or raster.Height <= 0 Then GoTo Failed
bounds.Width = CLng(raster.Width * 2540 / 96)
bounds.Height = CLng(raster.Height * 2540 / 96)
End If
Open ConvertFromURL("${pathToFileURL(dimensions).href}") For Output As #1
Print #1, CStr(bounds.Width) & "," & CStr(bounds.Height)
Close #1
If bounds.Width >= bounds.Height Then
scale = 1600 / bounds.Width
Else
scale = 1600 / bounds.Height
End If
pixels(0).Name = "PixelWidth"
pixels(0).Value = CLng(bounds.Width * scale)
pixels(1).Name = "PixelHeight"
pixels(1).Value = CLng(bounds.Height * scale)
If pixels(0).Value < 1 Then pixels(0).Value = CLng(1)
If pixels(1).Value < 1 Then pixels(1).Value = CLng(1)
target(0).Name = "URL"
target(0).Value = "${pathToFileURL(output).href}"
target(1).Name = "MediaType"
target(1).Value = "image/png"
target(2).Name = "FilterData"
target(2).Value = pixels()
options(0).Name = "Hidden"
options(0).Value = True
drawing = StarDesktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, options())
shape = drawing.createInstance("com.sun.star.drawing.GraphicObjectShape")
drawing.DrawPages.getByIndex(0).add(shape)
shape.Graphic = graphic
shape.Size = bounds
exporter = CreateUnoService("com.sun.star.drawing.GraphicExportFilter")
exporter.setSourceDocument(shape)
exporter.filter(target())
drawing.close(True)
StarDesktop.terminate()
Exit Sub
Failed:
StarDesktop.terminate()
End Sub`;
    fs.writeFileSync(path.join(basic, 'Standard/SealGraphics.xba'), declaration('script:module') + `<script:module xmlns:script="http://openoffice.org/2000/script" script:name="SealGraphics" script:language="StarBasic">${xml(macro)}</script:module>`);
    execFileSync(soffice, [environment, '--headless', '--nodefault', '--norestore', 'macro:///Standard.SealGraphics.ConvertImage()'], { stdio: 'pipe', timeout: 60000 });
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('LibreOffice did not produce an image preview');
    const match = /^\s*(\d+),(\d+)\s*$/.exec(fs.readFileSync(dimensions, 'utf8'));
    if (match === null) throw new Error('LibreOffice did not return the original image dimensions');
    const widthEmu = Number(match[1]) * 360, heightEmu = Number(match[2]) * 360;
    if (![widthEmu, heightEmu].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid original image dimensions');
    return { filePath: output, widthEmu, heightEmu };
  }

  async validateImage(bytes: Uint8Array, mime: string): Promise<void> {
    if (mime === 'image/bmp' || mime === 'image/x-ms-bmp') {
      validateBmp(bytes);
      return;
    }
    const rasterFormats: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
      'image/webp': 'webp', 'image/avif': 'heif', 'image/heic': 'heif',
    };
    const rasterFormat = rasterFormats[mime];
    if (rasterFormat) {
      const decoder = sharp(bytes, { failOn: 'warning', animated: true });
      const metadata = await decoder.metadata();
      if (metadata.format !== rasterFormat) throw new Error(`图片内容与声明的 ${mime} 格式不符`);
      await decoder.raw().toBuffer();
      return;
    }
    const extensions: Record<string, string> = {
      'image/x-wmf': 'wmf', 'image/wmf': 'wmf',
      'image/x-emf': 'emf', 'image/emf': 'emf',
    };
    const extension = extensions[mime];
    if (!extension) throw new Error(`宿主不支持解码 ${mime}`);
    if (extension === 'wmf') validateWmf(bytes);
    else validateEmf(bytes);
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'seal-image-'));
    try {
      const source = path.join(directory, `source.${extension}`);
      fs.writeFileSync(source, bytes, { flag: 'wx' });
      const result = await this.convertImageToPng(source, path.join(directory, 'output'));
      await validateImageBytes(fs.readFileSync(result.filePath), 'image/png');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  async normalizeImage(bytes: Uint8Array, filename: string): Promise<Uint8Array> {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 || bytes[0] === 0xff && bytes[1] === 0xd8) return bytes;
    const extension = path.extname(filename).toLowerCase();
    const formats: Record<string, string> = {
      '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
      '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic',
      '.wmf': 'image/x-wmf', '.emf': 'image/x-emf', '.bmp': 'image/bmp',
    };
    const mime = formats[extension];
    if (!mime) throw new Error('不支持此图片格式');
    await this.validateImage(bytes, mime);
    if (!['.wmf', '.emf', '.bmp'].includes(extension)) return sharp(bytes, { failOn: 'warning', page: 0 }).png().toBuffer();
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'seal-image-'));
    try {
      const source = path.join(directory, `source${extension}`);
      fs.writeFileSync(source, bytes, { flag: 'wx' });
      const result = await this.convertImageToPng(source, path.join(directory, 'output'));
      return fs.readFileSync(result.filePath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  joinPath(...segments: string[]): string {
    return path.join(...segments);
  }

  dirname(filePath: string): string {
    return path.dirname(filePath);
  }
}

function validateWmf(bytes: Uint8Array): void {
  const invalid = () => { throw new Error('WMF 结构无效或已截断'); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  if (bytes.length >= 4 && view.getUint32(0, true) === 0x9ac6cdd7) {
    if (bytes.length < 22) return invalid();
    let checksum = 0;
    for (let offset = 0; offset < 20; offset += 2) checksum ^= view.getUint16(offset, true);
    if (checksum !== view.getUint16(20, true)) return invalid();
    start = 22;
  }
  if (bytes.length < start + 18) return invalid();
  const type = view.getUint16(start, true), headerWords = view.getUint16(start + 2, true);
  const length = view.getUint32(start + 6, true) * 2;
  if ((type !== 1 && type !== 2) || headerWords !== 9 || length < 24 || start + length !== bytes.length) return invalid();
  let position = start + 18;
  while (position + 6 <= bytes.length) {
    const words = view.getUint32(position, true), code = view.getUint16(position + 4, true);
    if (words < 3 || position + words * 2 > bytes.length) return invalid();
    position += words * 2;
    if (code === 0) {
      if (words !== 3 || position !== bytes.length) return invalid();
      return;
    }
  }
  invalid();
}

function validateBmp(bytes: Uint8Array): void {
  const invalid = () => { throw new Error('BMP 结构无效或已截断'); };
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileSize = view.getUint32(2, true), offset = view.getUint32(10, true), header = view.getUint32(14, true);
  const width = view.getInt32(18, true), height = view.getInt32(22, true);
  const planes = view.getUint16(26, true), depth = view.getUint16(28, true), compression = view.getUint32(30, true);
  if (fileSize !== bytes.length || header < 40 || 14 + header > offset || offset >= bytes.length || width < 1 || height === 0 || Math.abs(height) * width > 100_000_000 || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(depth)) return invalid();
  if (!(compression === 0 || compression === 1 && depth === 8 || compression === 2 && depth === 4 || [3, 6].includes(compression) && [16, 32].includes(depth))) return invalid();
  if ([0, 3, 6].includes(compression) && offset + Math.ceil(width * depth / 32) * 4 * Math.abs(height) > bytes.length) return invalid();
  const decoded = decodeBmp(Buffer.from(bytes), { toRGBA: true });
  if (decoded.width !== width || decoded.height !== Math.abs(height) || decoded.data.length !== width * Math.abs(height) * 4) return invalid();
}

function validateEmf(bytes: Uint8Array): void {
  const invalid = () => { throw new Error('EMF 结构无效或已截断'); };
  if (bytes.length < 88) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(4, true), size = view.getUint32(48, true), records = view.getUint32(52, true);
  if (view.getUint32(0, true) !== 1 || headerSize < 88 || headerSize % 4 !== 0 || view.getUint32(40, true) !== 0x464d4520 || size !== bytes.length || records < 2) return invalid();
  let position = 0;
  while (position + 8 <= bytes.length) {
    const type = view.getUint32(position, true), length = view.getUint32(position + 4, true);
    if (length < 8 || length % 4 !== 0 || position + length > bytes.length) return invalid();
    position += length;
    if (type === 14) {
      if (length < 20 || position !== bytes.length) return invalid();
      return;
    }
  }
  invalid();
}

export function isPopplerPdfEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.SEAL_PDF_ENGINE === "poppler" ||
    Boolean(env.SEAL_PDFINFO || env.SEAL_PDFTOTEXT || env.SEAL_PDFTOPPM)
  );
}

export function findPopplerBinary(
  name: "pdfinfo" | "pdftotext" | "pdftoppm",
  envVar: string,
): string {
  if (process.env[envVar]) return process.env[envVar]!;
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  return candidates.find((file) => fs.existsSync(file)) ?? name;
}

export interface LibreOfficeStatus {
  available: boolean;
  binaryPath: string | null;
}

function resolveSofficeBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = fs.existsSync,
): { resolvedPath: string | null; fallbackCommand: string } {
  const override = env.SEAL_SOFFICE?.trim();
  const fallbackCommand = platform === "win32" ? "soffice.exe" : "soffice";
  if (override) {
    return {
      resolvedPath: exists(override) ? override : null,
      fallbackCommand: override,
    };
  }

  const candidates: string[] = [];
  if (platform === "win32") {
    const winJoin = path.win32.join;
    if (env.ProgramFiles) {
      candidates.push(winJoin(env.ProgramFiles, "LibreOffice", "program", "soffice.exe"));
    }
    if (env["ProgramFiles(x86)"]) {
      candidates.push(winJoin(env["ProgramFiles(x86)"], "LibreOffice", "program", "soffice.exe"));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(
        winJoin(env.LOCALAPPDATA, "LibreOffice", "program", "soffice.exe"),
        winJoin(env.LOCALAPPDATA, "Programs", "LibreOffice", "program", "soffice.exe"),
      );
    }
    candidates.push(
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/soffice",
      "/usr/local/bin/soffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    );
  } else {
    candidates.push(
      "/usr/bin/soffice",
      "/usr/local/bin/soffice",
      "/snap/bin/libreoffice",
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (exists(candidate)) {
      return { resolvedPath: candidate, fallbackCommand };
    }
  }

  const rawPath = env.PATH ?? (platform === "win32" ? env.Path : undefined) ?? "";
  if (rawPath) {
    const separator = platform === "win32" ? ";" : ":";
    const joiner = platform === "win32" ? path.win32.join : path.posix.join;
    const names = platform === "win32" ? ["soffice.exe", "soffice.com"] : ["soffice"];
    for (const rawDir of rawPath.split(separator)) {
      const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
      if (!dir) continue;
      for (const binName of names) {
        const candidate = joiner(dir, binName);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (exists(candidate)) {
          return { resolvedPath: candidate, fallbackCommand };
        }
      }
    }
  }

  return { resolvedPath: null, fallbackCommand };
}

export function findSofficeBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = fs.existsSync,
): string {
  const { resolvedPath, fallbackCommand } = resolveSofficeBinary(platform, env, exists);
  return resolvedPath ?? fallbackCommand;
}

export function detectLibreOfficeStatus(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = fs.existsSync,
): LibreOfficeStatus {
  const { resolvedPath } = resolveSofficeBinary(platform, env, exists);
  return resolvedPath ? { available: true, binaryPath: resolvedPath } : { available: false, binaryPath: null };
}

