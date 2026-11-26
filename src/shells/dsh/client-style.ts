export const clientStyle = `
.seal-ui {
  --seal-surface: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, var(--dsw-alias-bg-base));
  --seal-surface-raised: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, var(--dsw-alias-bg-base));
  --seal-surface-hover: color-mix(in srgb, var(--dsw-alias-interactive-bg-active) 72%, var(--dsw-alias-bg-base));
  --seal-border-soft: color-mix(in srgb, var(--dsw-alias-border-l3) 75%, transparent);
  --seal-ok: var(--dsw-alias-state-success-primary, color-mix(in srgb, #16a34a 78%, var(--dsw-alias-label-primary)));
  --seal-warn: var(--dsw-alias-state-warning-primary, color-mix(in srgb, #d97706 78%, var(--dsw-alias-label-primary)));
  --seal-info: var(--dsw-alias-state-business-primary);
  --seal-err: var(--dsw-alias-state-error-primary);
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
}
.seal-ui *,
.seal-ui *::before,
.seal-ui *::after {
  box-sizing: border-box;
}
.seal-page {
  padding: max(var(--dsh-frame-top-clearance, 0px), 24px) clamp(16px, 4vw, 44px) 48px max(var(--dsh-frame-leading-clearance, 0px), 24px);
}
.seal-content {
  max-width: 1000px;
  margin: 0 auto;
  min-width: 0;
}
.seal-panel {
  padding: 14px 14px 36px;
  min-width: 0;
}
.seal-ui h1 {
  font-size: 20px;
  line-height: 1.3;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}
.seal-ui h2 {
  font-size: 15px;
  line-height: 1.4;
  font-weight: 600;
  margin: 0 0 8px;
}
.seal-ui h3 {
  font-size: 14px;
  line-height: 1.4;
  font-weight: 600;
  margin: 0;
}
.seal-ui p {
  margin: 4px 0 8px;
  overflow-wrap: anywhere;
}
.seal-muted {
  color: var(--dsw-alias-label-secondary);
}
.seal-small {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.seal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.seal-between {
  justify-content: space-between;
}
.seal-stack {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.seal-stack-sm {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.seal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.seal-brand {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.seal-brand-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.seal-version-pill {
  font-size: 11px;
  line-height: 1.3;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  border: 1px solid var(--seal-border-soft);
}
.seal-ui button,
.seal-link {
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--seal-surface);
  color: var(--dsw-alias-label-primary);
  padding: 6px 12px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.seal-ui button:hover:not(:disabled),
.seal-link:hover {
  background: var(--seal-surface-hover);
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 22%, var(--dsw-alias-border-l3));
}
.seal-ui button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.seal-ui .seal-btn-primary,
.seal-ui .seal-primary {
  background: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 500;
}
.seal-ui .seal-btn-primary:hover:not(:disabled),
.seal-ui .seal-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 86%, var(--dsw-alias-label-primary));
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 86%, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-bg-base);
}
.seal-ui .seal-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--dsw-alias-label-secondary);
}
.seal-ui .seal-btn-ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
  border-color: transparent;
  color: var(--dsw-alias-label-primary);
}
.seal-ui .seal-btn-sm {
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 7px;
}
.seal-ui .seal-btn-danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--seal-err) 35%, var(--dsw-alias-border-l3));
  color: var(--seal-err);
}
.seal-ui .seal-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--seal-err) 10%, var(--dsw-alias-bg-base));
  border-color: color-mix(in srgb, var(--seal-err) 55%, var(--dsw-alias-border-l3));
  color: var(--seal-err);
}
.seal-ui .seal-btn-danger-solid {
  background: var(--seal-err);
  border-color: var(--seal-err);
  color: var(--dsw-alias-bg-base);
  font-weight: 500;
}
.seal-ui .seal-btn-danger-solid:hover:not(:disabled) {
  background: color-mix(in srgb, var(--seal-err) 86%, var(--dsw-alias-label-primary));
  border-color: color-mix(in srgb, var(--seal-err) 86%, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-bg-base);
}
.seal-confirm-inline {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--seal-err) 34%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--seal-err) 7%, var(--dsw-alias-bg-base));
  min-width: 0;
}
.seal-confirm-inline-text {
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.seal-confirm-inline-note {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.seal-ui button:focus-visible,
.seal-ui a:focus-visible,
.seal-ui input:focus-visible,
.seal-ui select:focus-visible,
.seal-ui textarea:focus-visible,
.seal-ui summary:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.seal-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l3);
  padding: 0 0 10px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.seal-tabs button {
  background: transparent;
  border-color: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 6px 12px;
  border-radius: 8px;
  font-weight: 500;
}
.seal-tabs button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
  border-color: transparent;
  color: var(--dsw-alias-label-primary);
}
.seal-tabs button[aria-selected="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, transparent);
}
.seal-tabs button[aria-selected="true"]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.seal-segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: var(--seal-surface-raised);
  border: 1px solid var(--seal-border-soft);
  max-width: 100%;
}
.seal-segmented button {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 500;
}
.seal-segmented button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  border-color: transparent;
  color: var(--dsw-alias-label-primary);
}
.seal-segmented button[aria-selected="true"] {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}
.seal-ui label {
  display: grid;
  gap: 5px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.seal-ui input:not([type="checkbox"]),
.seal-ui select,
.seal-ui textarea {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
}
.seal-ui textarea {
  min-height: 88px;
  resize: vertical;
}
.seal-card {
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  padding: 16px;
  min-width: 0;
}
.seal-card-compact {
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  padding: 12px 14px;
  min-width: 0;
}
.seal-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  min-width: 0;
}
.seal-callout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 13px 16px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, var(--dsw-alias-bg-base));
  min-width: 0;
}
.seal-callout-warn {
  border-color: color-mix(in srgb, var(--seal-warn) 34%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--seal-warn) 8%, var(--dsw-alias-bg-base));
}
.seal-callout-body {
  display: grid;
  gap: 2px;
  min-width: 0;
  flex: 1 1 260px;
}
.seal-env-banner {
  margin-bottom: 14px;
}
.seal-empty-hero {
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--seal-surface);
  border-radius: 14px;
  padding: 28px 24px;
  display: grid;
  gap: 18px;
  justify-items: center;
  text-align: center;
}
.seal-steps-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  text-align: left;
}
.seal-step-card {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--seal-border-soft);
  display: grid;
  gap: 4px;
  min-width: 0;
}
.seal-drop {
  position: relative;
  padding: 20px 16px;
  border: 1.5px dashed var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  display: grid;
  gap: 10px;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.seal-drop:hover,
.seal-drop-active,
.seal-drop:focus-within {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, var(--dsw-alias-bg-base));
}
.seal-drop-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.seal-drop-lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 180px;
  color: var(--dsw-alias-label-secondary);
}
.seal-drop-icon {
  flex: 0 0 auto;
  color: var(--dsw-alias-state-business-primary);
}
.seal-sr-only {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}
.seal-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.seal-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--seal-surface-raised);
  border: 1px solid var(--dsw-alias-border-l3);
  max-width: 100%;
  min-width: 0;
}
.seal-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.seal-ui .seal-chip-remove {
  border: 0;
  background: transparent;
  padding: 0 2px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
}
.seal-ui .seal-chip-remove:hover:not(:disabled) {
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
.seal-vault-header {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
}
.seal-vault-switcher {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1 1 240px;
  min-width: 0;
}
.seal-vault-switcher select {
  width: auto;
  min-width: 180px;
  max-width: 280px;
  font-weight: 500;
}
.seal-metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.seal-ui .seal-metric-pill {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-secondary);
}
.seal-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 1.4;
  font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l3);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  color: var(--dsw-alias-label-secondary);
  max-width: 100%;
}
.seal-badge-ok {
  color: var(--seal-ok);
  background: color-mix(in srgb, var(--seal-ok) 12%, transparent);
  border-color: color-mix(in srgb, var(--seal-ok) 30%, transparent);
}
.seal-badge-warn {
  color: var(--seal-warn);
  background: color-mix(in srgb, var(--seal-warn) 13%, transparent);
  border-color: color-mix(in srgb, var(--seal-warn) 32%, transparent);
}
.seal-badge-error {
  color: var(--seal-err);
  background: color-mix(in srgb, var(--seal-err) 12%, transparent);
  border-color: color-mix(in srgb, var(--seal-err) 30%, transparent);
}
.seal-badge-info {
  color: var(--seal-info);
  background: color-mix(in srgb, var(--seal-info) 12%, transparent);
  border-color: color-mix(in srgb, var(--seal-info) 30%, transparent);
}
.seal-pending-banner {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--seal-warn) 34%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--seal-warn) 7%, var(--dsw-alias-bg-base));
  padding: 14px 16px;
  display: grid;
  gap: 12px;
}
.seal-slice-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 14px;
  align-items: start;
}
.seal-slice-list {
  display: grid;
  gap: 6px;
  max-height: 440px;
  overflow-y: auto;
  min-width: 0;
}
.seal-ui button.seal-slice-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 4px;
  text-align: left;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l3);
}
.seal-ui button.seal-slice-row[aria-current="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-base));
}
.seal-slice-preview {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l3);
  display: grid;
  gap: 10px;
  min-width: 0;
}
.seal-slice-preview pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 12.5px;
  margin: 0;
  max-height: 280px;
  overflow-y: auto;
  color: var(--dsw-alias-label-secondary);
}
.seal-thumb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
}
.seal-thumb-card {
  display: grid;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--seal-surface);
  text-decoration: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  text-align: center;
}
.seal-thumb-card:hover {
  border-color: var(--dsw-alias-state-business-primary);
}
.seal-thumb-img {
  width: 100%;
  height: 112px;
  object-fit: cover;
  border-radius: 5px;
  display: block;
  background: var(--dsw-alias-bg-base);
}
.seal-subject-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.seal-subject-field {
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--seal-border-soft);
  display: grid;
  gap: 6px;
  min-width: 0;
}
.seal-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.seal-toolbar-search {
  flex: 1 1 180px;
  min-width: 0;
}
.seal-toolbar-select {
  width: auto !important;
  min-width: 120px;
}
.seal-evidence-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
  min-width: 0;
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
.seal-evidence-card.seal-row-selected,
.seal-card-compact.seal-row-selected {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-base));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 26%, transparent);
}
.seal-detail-panel {
  scroll-margin-top: 16px;
  min-width: 0;
}
.seal-detail-card {
  background: var(--dsw-alias-bg-base);
  border: 1.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, var(--dsw-alias-border-l3));
  box-shadow: 0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
}
.seal-evidence-thumb {
  width: 56px;
  height: 72px;
  flex: 0 0 56px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l3);
  object-fit: cover;
  background: var(--dsw-alias-bg-base);
}
.seal-evidence-thumb-empty {
  width: 56px;
  height: 72px;
  flex: 0 0 56px;
  border-radius: 7px;
  border: 1px dashed var(--dsw-alias-border-l3);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  background: var(--dsw-alias-bg-base);
}
.seal-evidence-main {
  flex: 1 1 0;
  min-width: 0;
  display: grid;
  gap: 6px;
}
.seal-divider {
  border-top: 1px solid var(--seal-border-soft);
  padding: 12px 0;
}
.seal-entry {
  padding: 12px;
  margin-bottom: 10px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--seal-surface);
  min-width: 0;
}
.seal-entry pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  margin: 6px 0;
}
.seal-entry del {
  color: var(--dsw-alias-label-secondary);
}
.seal-entry .seal-row {
  margin-top: 8px;
}
.seal-error {
  color: var(--seal-err);
  padding: 6px 0;
  overflow-wrap: anywhere;
}
.seal-notice {
  color: var(--seal-info);
  padding: 6px 0;
  overflow-wrap: anywhere;
}
.seal-banner {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--seal-surface);
  display: grid;
  gap: 8px;
  margin: 10px 0 12px;
}
.seal-ui details {
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 10px;
  background: var(--dsw-alias-bg-base);
}
.seal-ui summary {
  cursor: pointer;
  padding: 4px 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.seal-preview {
  width: 100%;
  height: auto;
  display: block;
  margin: 10px 0 16px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l3);
}
.seal-fields {
  display: grid;
  grid-template-columns: minmax(90px, 0.7fr) minmax(0, 2fr);
  gap: 10px 14px;
}
.seal-fields dd,
.seal-fields dt {
  margin: 0;
  overflow-wrap: anywhere;
  min-width: 0;
}
.seal-fields dt {
  color: var(--dsw-alias-label-secondary);
}
.seal-ui .seal-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.seal-section-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
  min-width: 0;
}
.seal-ui .seal-section-chip {
  font-size: 12px;
  line-height: 1.4;
  padding: 3px 9px;
  border-radius: 999px;
  max-width: 100%;
  min-width: 0;
  gap: 4px;
  color: var(--dsw-alias-label-secondary);
  background: var(--seal-surface);
  border-color: var(--dsw-alias-border-l3);
}
.seal-ui .seal-section-chip[aria-pressed="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);
  font-weight: 500;
}
.seal-section-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}
@media (max-width: 640px) {
  .seal-page {
    padding: max(var(--dsh-frame-top-clearance, 0px), 16px) 16px 32px;
  }
  .seal-grid-2,
  .seal-steps-3,
  .seal-slice-layout,
  .seal-subject-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .seal-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}
.seal-content-wide {
  max-width: 1440px;
  margin: 0 auto;
  min-width: 0;
}
.seal-mode-group {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.seal-ui button.seal-mode-option {
  display: grid;
  gap: 3px;
  justify-items: start;
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l3);
}
.seal-ui button.seal-mode-option[aria-pressed="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-base));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent);
}
.seal-outline-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
}
.seal-outline-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.seal-outline-grid {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 340px;
  gap: 14px;
  align-items: start;
  min-width: 0;
}
.seal-outline-nav,
.seal-outline-main,
.seal-outline-drawer {
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  padding: 12px;
  min-width: 0;
  display: grid;
  gap: 10px;
}
.seal-outline-nav-list {
  display: grid;
  gap: 3px;
  max-height: 460px;
  overflow-y: auto;
  min-width: 0;
}
.seal-ui button.seal-outline-nav-item {
  width: 100%;
  justify-content: flex-start;
  text-align: left;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.seal-ui button.seal-outline-nav-item:hover:not(:disabled) {
  background: var(--seal-surface-hover);
  border-color: transparent;
  color: var(--dsw-alias-label-primary);
}
.seal-ui button.seal-outline-nav-item[aria-current="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
  color: var(--dsw-alias-state-business-primary);
  font-weight: 500;
}
.seal-outline-stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--seal-border-soft);
}
.seal-outline-stat-cell {
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--seal-border-soft);
  display: grid;
  gap: 1px;
}
.seal-outline-row {
  display: grid;
  gap: 8px;
  padding: 9px 11px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l3);
  min-width: 0;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.seal-outline-row:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 20%, var(--dsw-alias-border-l3));
}
.seal-outline-row-selected {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, var(--dsw-alias-bg-base));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent);
}
.seal-outline-row-excluded {
  opacity: 0.62;
}
.seal-outline-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.seal-outline-row-title {
  flex: 1 1 180px;
  min-width: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.seal-outline-level {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
  color: var(--dsw-alias-label-secondary);
  flex: 0 0 auto;
}
.seal-outline-collapse {
  width: 22px;
  height: 22px;
  padding: 0 !important;
  font-size: 11px !important;
  border-radius: 6px !important;
  flex: 0 0 auto;
}
.seal-outline-compact-tree {
  display: grid;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
  padding: 8px;
  border-radius: 10px;
  background: var(--seal-surface);
  border: 1px solid var(--dsw-alias-border-l3);
  min-width: 0;
}
.seal-outline-compact-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--seal-border-soft);
  min-width: 0;
}
.seal-outline-req-list {
  display: grid;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  min-width: 0;
}
.seal-outline-req-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--seal-border-soft);
  cursor: pointer;
  min-width: 0;
}
.seal-outline-req-item input[type="checkbox"] {
  margin-top: 3px;
  flex: 0 0 auto;
}
.seal-outline-preview-thumb {
  width: 72px;
  height: 92px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
  display: block;
}
@media (max-width: 1120px) {
  .seal-outline-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
`;
