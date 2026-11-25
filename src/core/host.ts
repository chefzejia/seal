export interface FileStat {
  exists: boolean;
  size: number;
  isDirectory: boolean;
}

export interface ConvertedImage { filePath: string; widthEmu: number; heightEmu: number; }
export interface FileWrite { path: string; data: Uint8Array; createOnly?: boolean }
export interface ExtractedPdfPage { page: number; text: string; imagePath?: string }
export interface ExtractedPdfResult {
  pageCount: number;
  renderedPages: number;
  truncatedPages: number;
  pages: ExtractedPdfPage[];
}

export interface HostPort {
  readBytes(filePath: string): Promise<Uint8Array>;
  writeBytes(filePath: string, data: Uint8Array): Promise<void>;
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, content: string): Promise<void>;
  stat(filePath: string): Promise<FileStat>;
  removeDirectory?(dirPath: string): Promise<void>;
  removeFile?(filePath: string): Promise<void>;
  makeDirectory?(dirPath: string): Promise<void>;
  listFiles?(dirPath: string): Promise<string[]>;
  joinPath(...segments: string[]): string;
  dirname(filePath: string): string;
  convertDocToDocx?(inputPath: string, outDir: string): Promise<string>;
  convertImageToPng?(inputPath: string, outDir: string): Promise<ConvertedImage>;
  validateImage?(bytes: Uint8Array, mime: string): Promise<void>;
  normalizeImage?(bytes: Uint8Array, filename: string): Promise<Uint8Array>;
  writeFiles?(files: readonly FileWrite[]): Promise<void>;
  authorizationKey?(create: boolean): Promise<Uint8Array | null>;
  ledgerAnchorPath?(projectRoot: string, create: boolean): Promise<string>;
  renderDocxPages?(docxPath: string, outDir: string): Promise<string[]>;
  extractDocxPageTexts?(docxBytes: Uint8Array): Promise<string[]>;
  extractPdf?(
    inputPath: string,
    outDir: string,
    options?: { dpi?: number; maxPages?: number },
  ): Promise<ExtractedPdfResult>;
  convertSpreadsheetToXlsx?(inputPath: string, outDir: string): Promise<string>;
  convertImageBytesToPng?(bytes: Uint8Array, mime: string): Promise<Uint8Array>;
}
