/**
 * Pure reducer for the ModelPicker chip label (founder-directed fix: the chip
 * must show the selected model IMMEDIATELY after activation, without another
 * interaction).
 *
 * The picker subscribes to `model:status` — every activation path (onboarding
 * finishWith, llm:setActiveModel/ById, addCloudModel activate) emits it with
 * the model name. This function decides what the chip should show for each
 * event; extracted pure so the regression test runs without a DOM.
 */
export interface ModelStatusEvent {
  phase: 'checking' | 'starting' | 'warming' | 'ready' | 'not_installed' | 'no_model' | 'error';
  model?: string;
}

export function activeModelFromStatus(current: string | null, s: ModelStatusEvent): string | null {
  // A lifecycle event that names a model is authoritative — the runtime only
  // names the ACTIVE model in these phases.
  if ((s.phase === 'ready' || s.phase === 'warming' || s.phase === 'starting') && s.model) {
    return s.model;
  }
  // Nothing configured any more (model removed / configure-later) → honest empty chip.
  if (s.phase === 'no_model') return null;
  // checking / not_installed / error carry no activation information.
  return current;
}
