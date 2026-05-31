/**
 * HTML → readable markdown extraction.
 * Uses Mozilla's Readability (the same library Firefox Reader View ships with)
 * to strip navigation chrome, ads, and boilerplate, then renders the article
 * body to compact markdown the LLM can consume cheaply.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

/** Cleaned article returned by `extractReadable`. `content` is compact markdown
 *  (not HTML) — suitable for direct injection into an LLM context window. */
export interface ReadableArticle {
  title: string;
  /** Author line, e.g. "By Jane Smith", or null when absent. */
  byline: string | null;
  /** One-sentence article summary Readability infers from the opening text. */
  excerpt: string | null;
  /** Main body converted to markdown via `htmlToMarkdown`. */
  content: string;
  /** Approximate character count of the original article body. */
  length: number;
  siteName: string | null;
}

/** Extract the main article from an HTML document. Returns null on failure. */
export function extractReadable(html: string, url: string): ReadableArticle | null {
  // Silence noisy CSS / network warnings that jsdom emits for arbitrary web pages.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, virtualConsole });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  if (!parsed) return null;
  return {
    title: parsed.title ?? '',
    byline: parsed.byline ?? null,
    excerpt: parsed.excerpt ?? null,
    content: htmlToMarkdown(parsed.content ?? ''),
    length: parsed.length ?? 0,
    siteName: parsed.siteName ?? null,
  };
}

/**
 * Minimal HTML → markdown. Readability already gives us clean semantic HTML,
 * so we just translate the handful of tags it emits. Avoids the weight (and
 * brittleness) of pulling in turndown / a full transformer.
 */
function htmlToMarkdown(html: string): string {
  let out = html;
  // Strip script/style outright
  out = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // Headings
  out = out.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  out = out.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
  // Links
  out = out.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Emphasis
  out = out.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
  out = out.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*');
  // Code
  out = out.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  // Lists
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  // Paragraphs / breaks
  out = out.replace(/<p[^>]*>/gi, '\n\n');
  out = out.replace(/<\/p>/gi, '\n');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  // Drop remaining tags
  out = out.replace(/<[^>]+>/g, '');
  // Decode the most common entities
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace runs
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}
