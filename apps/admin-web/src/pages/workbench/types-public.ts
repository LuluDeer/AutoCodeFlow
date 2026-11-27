/**
 * Transitional type barrel for the workbench feature.
 *
 * `pages/workbench/types.ts` owns the canonical aliases; this re-export keeps
 * hook/component imports short and gives one place to switch to generated
 * `components['schemas']` aliases later.
 */
export type {
  WorkbenchApprovalDecision,
  WorkbenchApprovalItem,
  WorkbenchArtifact,
  WorkbenchArtifactPreview,
  WorkbenchCreateChatInput,
  WorkbenchMessageMode,
  WorkbenchSessionActionResult,
  WorkbenchSessionDetail,
  WorkbenchSessionKind,
  WorkbenchSessionListItem,
  WorkbenchStep,
  WorkbenchToolCall,
  ComposerCadence,
} from './types';
