export type KbKind = 'subject' | 'record' | 'material';
export type KbValue = string | string[] | boolean;
export type KbFields = Record<string, KbValue>;

export interface VaultMetadata {
  format: 'seal-kb-2';
  vaultId: string;
  name: string;
  createdAt: string;
}

export interface KbEntry {
  id: string;
  kind: KbKind;
  fields: KbFields;
  body: string;
  verified: boolean;
  verifiedFields: string[];
  issues: string[];
}

export type SaveAction = 'create' | 'update' | 'delete' | 'attach_file' | 'dismiss_candidate' | 'dismiss_candidates';

export interface SaveInput {
  action: SaveAction;
  kind: KbKind;
  id?: string;
  ids?: string[];
  dismissCandidateIds?: string[];
  fields?: Record<string, unknown>;
  body?: string;
  file?: { fileName: string; bytes: Uint8Array };
}

export interface HealthIssue {
  code: string;
  kind: KbKind | 'vault' | 'candidate';
  id: string;
  field?: string;
  message: string;
}

export interface HealthReport {
  vaultId: string;
  referenceDate: string;
  records: Array<KbEntry & { validity: 'valid' | 'expiring_soon' | 'expired' | 'unknown' | 'not_applicable'; subject: 'self' | 'third_party' | 'forbidden' | 'mismatch' | 'unknown' }>;
  issues: HealthIssue[];
}

export type IngestSourceType = 'docx' | 'pdf' | 'image' | 'spreadsheet' | 'text';

export interface IngestCandidate {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  sourceType?: IngestSourceType;
  location: string;
  imageFiles: string[];
  processed: boolean;
}

export interface PendingBatchSummary {
  batchId: string;
  totalCandidates: number;
  pendingCount: number;
  sampleIds: string[];
  sources: string[];
}

export interface CandidateListItem {
  id: string;
  title: string;
  source: string;
  location: string;
  sourceType?: IngestSourceType;
  imageCount: number;
  processed: boolean;
}

export interface DeleteBatchResult {
  batchId: string;
  removedCandidates: number;
  removedFiles: number;
  preservedFiles: number;
}
