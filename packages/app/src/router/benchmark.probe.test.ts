import { describe, it, expect } from 'vitest';
import { scoreToolCallReply } from './benchmark';

describe('scoreToolCallReply (real tool-call probe)', () => {
  it('scores a well-formed structured call to the offered tool', () => {
    expect(scoreToolCallReply({ text: '', toolCalls: [{ name: 'fs_list_directory', args: { path: '/Users/me/Desktop' } }] })).toBe(1);
    expect(scoreToolCallReply({ text: '', toolCalls: [{ name: 'fs_list_directory', args: { path: '~/Desktop' } }] })).toBe(1);
  });
  it('gives partial credit for a call with a weak path', () => {
    expect(scoreToolCallReply({ text: '', toolCalls: [{ name: 'fs_list_directory', args: { path: '/Users/me/Documents' } }] })).toBe(0.75);
    expect(scoreToolCallReply({ text: '', toolCalls: [{ name: 'fs_list_directory', args: { path: 'Desktop' } }] })).toBe(0.5);
    expect(scoreToolCallReply({ text: '', toolCalls: [{ name: 'fs_list_directory', args: {} }] })).toBe(0.25);
  });
  it('scores 0 for prose, JSON-in-text, or a call to a tool that was not offered', () => {
    expect(scoreToolCallReply({ text: '{"path": "/Users/me/Desktop"}', toolCalls: [] })).toBe(0);
    expect(scoreToolCallReply({ text: 'I would list your Desktop.', toolCalls: [] })).toBe(0);
    expect(scoreToolCallReply({ text: '', toolCalls: [{ name: 'list_directory', args: { path: '/Users/me/Desktop' } }] })).toBe(0);
  });
});
