/**
 * Regression test for the founder-directed ModelPicker fix (validation row 1
 * defect): the chip must reflect the activated model immediately from
 * `model:status` events — no interaction required. Pure reducer, node-run.
 */
import { describe, it, expect } from 'vitest';
import { activeModelFromStatus } from './modelStatusLabel';

describe('activeModelFromStatus', () => {
  it('onboarding finish: warming/ready events with a model update a "No model" chip immediately', () => {
    // The exact row-1 sequence after finishWith(): setActiveModel → ensureModelReady emits.
    let chip: string | null = null;
    chip = activeModelFromStatus(chip, { phase: 'warming', model: 'qwen2.5:14b-instruct-q4_K_M' });
    expect(chip).toBe('qwen2.5:14b-instruct-q4_K_M');
    chip = activeModelFromStatus(chip, { phase: 'ready', model: 'qwen2.5:14b-instruct-q4_K_M' });
    expect(chip).toBe('qwen2.5:14b-instruct-q4_K_M');
  });

  it('cloud activation: ready event (cloud path emits ready directly) names the model', () => {
    expect(activeModelFromStatus(null, { phase: 'ready', model: 'gpt-4o-mini' })).toBe('gpt-4o-mini');
  });

  it('switching models mid-session replaces the chip on the new warm-up', () => {
    expect(activeModelFromStatus('llama3.2:3b', { phase: 'starting', model: 'qwen2.5:14b' })).toBe('qwen2.5:14b');
  });

  it('no_model clears the chip (model removed / configure-later)', () => {
    expect(activeModelFromStatus('llama3.2:3b', { phase: 'no_model' })).toBeNull();
  });

  it('phases without activation information never clobber the chip', () => {
    expect(activeModelFromStatus('kept', { phase: 'checking' })).toBe('kept');
    expect(activeModelFromStatus('kept', { phase: 'error' })).toBe('kept');
    expect(activeModelFromStatus('kept', { phase: 'not_installed' })).toBe('kept');
    expect(activeModelFromStatus('kept', { phase: 'ready' })).toBe('kept'); // ready w/o model name
  });
});
