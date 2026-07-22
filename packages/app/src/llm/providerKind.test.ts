/**
 * providerKind tests — provider classification + id normalization
 * (Phase A commit 2).
 */
import { describe, it, expect } from 'vitest';
import {
  isOllamaManaged,
  normalizeProvider,
  normalizeProviderIds,
  type ProviderMigrationDb,
} from './providerKind';

describe('isOllamaManaged', () => {
  it('trusts an explicit non-ollama provider id regardless of URL', () => {
    expect(isOllamaManaged('openai', 'https://api.openai.com/v1')).toBe(false);
    expect(isOllamaManaged('anthropic', 'https://api.anthropic.com/v1')).toBe(false);
    // Even a cloud provider proxied through a local tunnel is NOT ours to manage.
    expect(isOllamaManaged('openai', 'http://localhost:11434/v1')).toBe(false);
  });

  it('recognizes local Ollama rows by provider id + local URL', () => {
    expect(isOllamaManaged('ollama', 'http://localhost:11434/v1')).toBe(true);
    expect(isOllamaManaged('ollama', 'http://127.0.0.1:11434/v1')).toBe(true);
    expect(isOllamaManaged('ollama', undefined)).toBe(true);
  });

  it('legacy rows: falls back to URL shape when provider is missing', () => {
    expect(isOllamaManaged(undefined, 'http://localhost:11434/v1')).toBe(true);
    expect(isOllamaManaged(null, 'https://api.openai.com/v1')).toBe(false);
    expect(isOllamaManaged(undefined, undefined)).toBe(false);
  });

  it("legacy 'ollama'-stamped rows with a REMOTE url are not Ollama-managed", () => {
    expect(isOllamaManaged('ollama', 'https://my-vllm.example.com/v1')).toBe(false);
    // Other local ports (LM Studio :1234) are not the Ollama daemon either.
    expect(isOllamaManaged('ollama', 'http://localhost:1234/v1')).toBe(false);
  });
});

describe('normalizeProvider', () => {
  it('keeps explicit cloud ids and lowercases them', () => {
    expect(normalizeProvider('OpenAI', 'https://api.openai.com/v1')).toBe('openai');
    expect(normalizeProvider('anthropic', 'https://api.anthropic.com/v1')).toBe('anthropic');
  });

  it("repairs 'ollama'-default rows pointing at remote endpoints to 'custom'", () => {
    expect(normalizeProvider('ollama', 'https://my-endpoint.example.com/v1')).toBe('custom');
    expect(normalizeProvider('', 'https://api.together.xyz/v1')).toBe('custom');
    expect(normalizeProvider(undefined, 'http://localhost:1234/v1')).toBe('custom');
  });

  it('leaves genuine local rows as ollama', () => {
    expect(normalizeProvider('ollama', 'http://localhost:11434/v1')).toBe('ollama');
    expect(normalizeProvider(undefined, 'http://127.0.0.1:11434/v1')).toBe('ollama');
    expect(normalizeProvider('ollama', undefined)).toBe('ollama');
  });
});

describe('normalizeProviderIds migration', () => {
  function fakeDb(rows: { model_id: string; provider: string | null; base_url: string | null }[]) {
    const db: ProviderMigrationDb & { rows: typeof rows } = {
      rows,
      prepare(sql: string) {
        return {
          all: () => rows.map(r => ({ ...r })),
          run: (...args: unknown[]) => {
            const [provider, id] = args as [string, string];
            const row = rows.find(r => r.model_id === id);
            if (row) row.provider = provider;
            return { changes: row ? 1 : 0 };
          },
        };
      },
    };
    return db;
  }

  it('repairs only the mismatched rows and is idempotent', () => {
    const db = fakeDb([
      { model_id: 'a', provider: 'ollama', base_url: 'http://localhost:11434/v1' },
      { model_id: 'b', provider: 'ollama', base_url: 'https://api.groq.com/openai/v1' },
      { model_id: 'c', provider: 'openai', base_url: 'https://api.openai.com/v1' },
      { model_id: 'd', provider: null, base_url: 'http://localhost:11434/v1' },
    ]);
    expect(normalizeProviderIds(db)).toBe(2); // b → custom, d → ollama (stamped)
    expect(db.rows.find(r => r.model_id === 'a')!.provider).toBe('ollama');
    expect(db.rows.find(r => r.model_id === 'b')!.provider).toBe('custom');
    expect(db.rows.find(r => r.model_id === 'c')!.provider).toBe('openai');
    expect(db.rows.find(r => r.model_id === 'd')!.provider).toBe('ollama');
    expect(normalizeProviderIds(db)).toBe(0); // second pass: nothing to do
  });
});
