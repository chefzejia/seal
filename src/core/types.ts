export type SlotKind =
  | "table_cell_slot"
  | "table_row_repeat_slot"
  | "inline_blank_slot"
  | "checkbox_slot"
  | "section_mount_slot";

export interface TemplateSlot {
  locator: string;
  kind: SlotKind;
  label: string;
  currentText: string;
  contextHeading?: string;
  tableIndex?: number;
  rowIndex?: number;
  cellIndex?: number;
  paragraphIndex?: number;
  inlineIndex?: number;
  checkboxIndex?: number;
  options?: string[];
  repeatRowCount?: number;
  columnLabels?: string[];
  authority?: "prompt" | "bracket";
  fillRole?: "required" | "optional";
  context?: { ownPrefix: string; ownSuffix: string; rowLabels: string[]; columnLabels: string[]; headings: string[] };
}

export interface TemplateExampleBlock {
  locator: string;
  description: string;
  paragraphIndices: number[];
  tableIndices: number[];
}

export interface FrozenBlockDigest {
  blockId: string;
  kind: "paragraph" | "table";
  index: number;
  xmlHash: string;
  textSummary: string;
}

export interface PageGeometry {
  pageWidthTwips: number;
  pageHeightTwips: number;
  marginLeftTwips: number;
  marginRightTwips: number;
  marginTopTwips: number;
  marginBottomTwips: number;
  contentWidthTwips: number;
  contentHeightTwips: number;
  contentWidthEmu: number;
  contentHeightEmu: number;
}

export interface TemplateInspectionResult {
  slots: TemplateSlot[];
  bracketLegendBlockIds?: string[];
  exampleBlocks: TemplateExampleBlock[];
  frozenDigests: FrozenBlockDigest[];
  pageGeometry: PageGeometry;
  summary: {
    totalParagraphs: number;
    totalTables: number;
    slotCountsByKind: Record<SlotKind, number>;
    exampleBlockCount: number;
    frozenBlockCount: number;
  };
}

export interface ImageAttachment {
  fileName: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  widthEmu?: number;
  heightEmu?: number;
  caption?: string;
}

export type PatchOperationType =
  | "fill_text"
  | "toggle_checkbox"
  | "repeat_table_rows"
  | "mount_image"
  | "remove_example_block";

export interface PatchOperation {
  locator: string;
  action: PatchOperationType;
  value?: string;
  highlightYellow?: boolean;
  checked?: boolean;
  rows?: Array<Record<number, { text: string; highlightYellow?: boolean }> | string[]>;
  image?: ImageAttachment;
}

export interface FidelityDrift {
  blockId: string;
  expectedHash: string;
  actualHash: string;
  summary: string;
}

export interface FidelityReport {
  ok: boolean;
  checkedBlockCount: number;
  drifts: FidelityDrift[];
  missingMediaRelationships: string[];
  unappliedPatches: string[];
}
