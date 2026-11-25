export { readZip, writeZip, sha256Hex, crc32, parseImageDimensions } from "./zip.js";
export {
  extractPlainText,
  normalizeXmlDigest,
  parseDocumentBody,
  parseTableRows,
  extractFirstParagraphPr,
  sanitizeInsertedBodyParagraphPr,
  extractFirstRunPr,
  injectHighlightYellow,
} from "./xml.js";
export {
  applyInsertToc,
  ensureUpdateFieldsSetting,
  findTopLevelTocFields,
  hasCustomPageNumbering,
  patchTocPageNumbers,
  resolveTocPageNumbers,
  validateInsertTocEdit,
  type InsertTocEdit,
  type TocApplyResult,
  type TocFieldSpan,
  type TocHeading,
  type TocPageHint,
} from "./toc.js";
