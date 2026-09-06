/**
 * Streaming Ollama pull, shared by the user-driven Browse/Onboarding download
 * (ipc `llm:pullModelStream`) and Artha's own background provisioning
 * (router/modelProvisioner.ts). One implementation of the NDJSON protocol and
 * its two non-obvious failure shapes:
 *   - Ollama answers HTTP 200 and reports failures as an `{"error": …}` LINE,
 *     then ends the stream normally — so a 404 manifest / full disk must be
 *     caught from the lines, not the status.
 *   - A finished stream is not proof of install; `/api/tags` is.
 * Never throws; the caller decides how to surface `error`.
 */

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export interface PullResult {
  ok: boolean;
  error?: string;
}

/** Does `/api/tags` list `name` (exact or as a tag-prefix match)? */
export async function isModelInstalled(name: string, base = 'http://localhost:11434'): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/tags`);
    const json = await res.json() as { models?: { name: string }[] };
    return (json.models ?? []).some(m => m.name === name || m.name.startsWith(`${name}:`) || name.startsWith(`${m.name}:`));
  } catch { return false; }
}

export async function pullOllamaModel(
  name: string,
  onProgress?: (p: PullProgress) => void,
  opts: { base?: string; signal?: AbortSignal } = {},
): Promise<PullResult> {
  const base = opts.base ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      body: JSON.stringify({ name, stream: true }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) return { ok: false, error: `Ollama responded ${res.status}` };
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (obj.error) streamError = obj.error;
          const percent = obj.total && obj.completed ? Math.round((obj.completed / obj.total) * 100) : undefined;
          onProgress?.({ status: obj.status ?? 'pulling', completed: obj.completed, total: obj.total, percent });
        } catch { /* partial line */ }
      }
    }
    if (streamError) return { ok: false, error: streamError };
    if (!(await isModelInstalled(name, base))) {
      return { ok: false, error: 'The download finished but the model is not installed.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
