/**
 * Document Generation Engine — Artha's primary differentiator.
 * Converts natural-language prompts into polished DOCX, PPTX, XLSX, PDF files.
 *
 * Provenance-anchored: every section carries a stable anchor ID that resolves
 * to a provenance record (source = rag chunk / tool result / llm / user input).
 * After write, a sidecar `.artha-receipt.json` is emitted next to the file and
 * the artifact is registered in `generated_documents` + `provenance_records`.
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
  LevelFormat, TableOfContents, Header, Footer, PageNumber, Bookmark
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getActiveLLMClient } from '../llm/client';
import { getDb } from '../db/schema';

/** Artifact format. Each maps to one of the generator functions below. */
export type DocType = 'docx' | 'pptx' | 'xlsx' | 'pdf';

/** One piece of grounding context fed to the LLM planner — typically a RAG
 *  chunk, a tool result, or user-supplied snippet. `id` is the handle the
 *  LLM cites back via `sourceIds` so we can attach provenance to the section. */
export interface SourceChunk {
  id: string;          // stable id (rag chunk hash, tool_call id, etc.)
  type: 'rag' | 'tool' | 'user';
  ref: string;         // file path, tool name, or label
  text: string;
}

/** Inputs to `generateDocument()`. `contextChunks` accepts either bare strings
 *  (auto-wrapped as RAG sources) or fully-typed SourceChunks. */
export interface GenerateOptions {
  type: DocType;
  prompt: string;
  outPath: string;
  contextChunks?: string[] | SourceChunk[];
  sessionId?: string;
}

/** What `generateDocument()` returns: the artifact path, its row id in
 *  `generated_documents`, the sidecar receipt path, the SHA-256 of the file,
 *  and how many provenance anchors were registered. */
export interface GenerateResult {
  filePath: string;
  docId: string;
  receiptPath: string;
  contentHash: string;
  anchors: number;
}

// ── Main entry point ────────────────────────────────────────────────────────

/** Single public entry point. Flow:
 *    1. Normalise context chunks → SourceChunks
 *    2. Ask the LLM for a structured plan (title + sections + tables/bullets)
 *    3. Attach a stable anchor + provenance record to every section
 *    4. Dispatch to the format-specific generator (docx/pptx/xlsx/pdf)
 *    5. Hash the artifact, write the sidecar receipt, register in SQLite */
export async function generateDocument(opts: GenerateOptions): Promise<GenerateResult> {
  const sources = normaliseSources(opts.contextChunks);
  const planned = await planDocumentContent(opts.prompt, sources);
  const content = attachAnchors(planned, sources);
  const model = await getActiveModelName();

  let filePath: string;
  switch (opts.type) {
    case 'docx': filePath = await generateDocx(content, opts.outPath); break;
    case 'pptx': filePath = await generatePptx(content, opts.outPath); break;
    case 'xlsx': filePath = await generateXlsx(content, opts.outPath); break;
    case 'pdf':  filePath = await generatePdf(content, opts.outPath); break;
    default: throw new Error(`Unsupported document type: ${opts.type}`);
  }

  return registerProvenance({
    filePath,
    docType: opts.type,
    title: content.title,
    prompt: opts.prompt,
    model,
    sessionId: opts.sessionId,
    content,
  });
}

// ── LLM Content Planner ─────────────────────────────────────────────────────

/** Raw shape returned by the planning LLM call. May or may not include
 *  per-section `sourceIds` depending on whether the model chose to cite. */
interface PlannedSection {
  heading: string;
  body?: string;
  bullets?: string[];
  table?: { headers: string[]; rows: string[][] };
  /** Optional citation: index into sources[] the LLM was given. */
  sourceIds?: string[];
}

/** Top-level planner response: title + ordered sections + free-form metadata. */
interface PlannedContent {
  title: string;
  sections: PlannedSection[];
  metadata?: Record<string, string>;
}

/** Planned section after `attachAnchors()` has stamped it with a stable id
 *  and resolved its `sourceIds[0]` into a concrete provenance record. */
interface AnchoredSection extends PlannedSection {
  anchor: string;
  provenance: { type: 'rag' | 'tool' | 'llm' | 'user'; ref: string; excerpt: string };
}

/** Anchored version of `PlannedContent` — what every format generator consumes. */
interface AnchoredContent {
  title: string;
  titleAnchor: string;
  sections: AnchoredSection[];
  metadata?: Record<string, string>;
}

/** Accept either bare strings (treated as RAG context with auto-IDs) or
 *  fully-typed SourceChunks. Keeps the public API ergonomic for both ad-hoc
 *  calls from the orchestrator and structured ones from the IPC layer. */
function normaliseSources(chunks?: string[] | SourceChunk[]): SourceChunk[] {
  if (!chunks?.length) return [];
  if (typeof chunks[0] === 'string') {
    return (chunks as string[]).map((text, i) => ({
      id: `ctx-${i}`,
      type: 'rag' as const,
      ref: `context-chunk-${i}`,
      text,
    }));
  }
  return chunks as SourceChunk[];
}

/** Ask the LLM to return a structured JSON outline of the document. Sources
 *  (when present) are inlined into the system prompt as `[id]` blocks so the
 *  model can cite them back via `sourceIds`. Falls back to a single-section
 *  doc if the model's JSON is malformed (small local models do this often). */
async function planDocumentContent(
  prompt: string,
  sources: SourceChunk[]
): Promise<PlannedContent> {
  const llm = getActiveLLMClient(undefined, 'synthesis');
  const sourceBlock = sources.length
    ? `\n\nSources (cite by id in "sourceIds" when used):\n${sources.map(s => `[${s.id}] (${s.type}:${s.ref}) ${s.text.slice(0, 240)}`).join('\n')}`
    : '';

  const response = await llm.complete([
    {
      role: 'system',
      content: `You are Artha's document architect. Given a user request, produce structured document content as JSON.

Schema:
{
  "title": "Document Title",
  "sections": [
    {
      "heading": "Section Title",
      "body": "Paragraph text...",
      "bullets": ["Point 1", "Point 2"],
      "table": { "headers": ["Col1","Col2"], "rows": [["r1c1","r1c2"]] },
      "sourceIds": ["ctx-0", "ctx-2"]
    }
  ],
  "metadata": { "author": "...", "date": "...", "subject": "..." }
}

Be thorough, professional, and ground factual claims in the provided sources by citing their ids in "sourceIds".${sourceBlock}`,
    },
    { role: 'user', content: prompt },
  ]);

  const raw = response.choices[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(raw.replace(/```json\n?|\n?```/g, ''));
  } catch {
    return { title: 'Document', sections: [{ heading: 'Content', body: raw }] };
  }
}

/** Stamp every section with a random anchor id and resolve its first cited
 *  source into a concrete `provenance` record. When no source was cited we
 *  fall back to `type='llm'` so the receipt still describes the section. */
function attachAnchors(content: PlannedContent, sources: SourceChunk[]): AnchoredContent {
  const srcMap = new Map(sources.map(s => [s.id, s]));
  return {
    title: content.title || 'Untitled',
    titleAnchor: makeAnchor(),
    metadata: content.metadata,
    sections: (content.sections ?? []).map(s => {
      const sourceId = s.sourceIds?.[0];
      const src = sourceId ? srcMap.get(sourceId) : undefined;
      const provenance = src
        ? { type: src.type, ref: src.ref, excerpt: src.text.slice(0, 280) }
        : { type: 'llm' as const, ref: 'generated', excerpt: (s.body ?? s.bullets?.join(' ') ?? '').slice(0, 280) };
      return { ...s, anchor: makeAnchor(), provenance };
    }),
  };
}

/** Generate a random anchor id. Prefixed with 'a' so the result is always a
 *  valid XML NMTOKEN (DOCX bookmark IDs cannot start with a digit and cannot
 *  contain dashes). 16 hex chars gives 64 bits of entropy — collision-free
 *  in practice for documents that have ≪ 2^32 sections. */
function makeAnchor(): string {
  return 'a' + crypto.randomBytes(8).toString('hex');
}

/** Look up the currently-active LLM's ollama_name from SQLite so it can be
 *  stored in the receipt. Returns 'unknown' on any DB error to keep the rest
 *  of the generation pipeline from failing over a cosmetic metadata field. */
async function getActiveModelName(): Promise<string> {
  try {
    const row = getDb().prepare(`SELECT ollama_name FROM llm_models WHERE is_active=1 LIMIT 1`).get() as { ollama_name: string } | undefined;
    return row?.ollama_name ?? 'unknown';
  } catch { return 'unknown'; }
}

// ── DOCX Generator ──────────────────────────────────────────────────────────
// Builds a real Office-style document via the `docx` package: cover page,
// table of contents, headings, paragraphs, alternating-row tables, header +
// footer with page numbers. Section bookmarks use the anchor IDs from
// AnchoredContent so external tooling can resolve "anchor → location in doc".

/** Build a polished `.docx` and write it to `outPath`. */
async function generateDocx(content: AnchoredContent, outPath: string): Promise<string> {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };

  const bodyChildren: (Paragraph | Table)[] = [
    new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-2' }),
    new Paragraph({ children: [] }),
  ];

  for (const section of content.sections) {
    bodyChildren.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new Bookmark({ id: section.anchor, children: [new TextRun(section.heading)] })],
      })
    );

    if (section.body) {
      bodyChildren.push(
        new Paragraph({ spacing: { after: 160 }, children: [new TextRun(section.body)] })
      );
    }

    if (section.bullets?.length) {
      for (const bullet of section.bullets) {
        bodyChildren.push(
          new Paragraph({
            numbering: { reference: 'bullets', level: 0 },
            spacing: { after: 80 },
            children: [new TextRun(bullet)],
          })
        );
      }
    }

    if (section.table) {
      const { headers, rows } = section.table;
      const colW = Math.floor(9360 / headers.length);
      const colWidths = headers.map(() => colW);

      bodyChildren.push(
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: colWidths,
          rows: [
            new TableRow({
              children: headers.map((h, i) =>
                new TableCell({
                  borders, width: { size: colWidths[i], type: WidthType.DXA },
                  shading: { fill: '1B4F72', type: ShadingType.CLEAR },
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 20 })] })],
                })
              ),
            }),
            ...rows.map((row, ri) =>
              new TableRow({
                children: row.map((cell, ci) =>
                  new TableCell({
                    borders, width: { size: colWidths[ci], type: WidthType.DXA },
                    shading: { fill: ri % 2 === 0 ? 'FFFFFF' : 'EAF4FB', type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [new Paragraph({ children: [new TextRun({ text: cell, size: 20 })] })],
                  })
                ),
              })
            ),
          ],
        })
      );
      bodyChildren.push(new Paragraph({ children: [] }));
    }
  }

  const doc = new Document({
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, font: 'Arial', color: '1B4F72' }, paragraph: { spacing: { before: 300, after: 120 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, font: 'Arial', color: '2E86C1' }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 1 } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: content.title, bold: true, color: '1B4F72', font: 'Arial', size: 18 })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: 'Generated by Artha  •  ', color: '888888', font: 'Arial', size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: '888888', font: 'Arial', size: 18 })] })] }) },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 1440, after: 480 },
          children: [
            new Bookmark({
              id: content.titleAnchor,
              children: [new TextRun({ text: content.title, size: 52, bold: true, color: '1B4F72', font: 'Arial' })],
            }),
          ],
        }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 1440 }, children: [new TextRun({ text: content.metadata?.date ?? new Date().toLocaleDateString(), color: '888888', font: 'Arial', size: 22 })] }),
        ...bodyChildren,
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ── PPTX Generator ──────────────────────────────────────────────────────────
// One title slide + one slide per planned section. The anchor + provenance
// string is written into each slide's *speaker notes* (`[artha-anchor:...]`)
// so the receipt has a target it can resolve in tools like PowerPoint's
// outline view, and so anchors survive a round-trip edit.

/** Build a wide-layout `.pptx` and write it to `outPath`. */
async function generatePptx(content: AnchoredContent, outPath: string): Promise<string> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = content.title;
  pptx.author = content.metadata?.author ?? 'Artha';

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: '1B4F72' };
  titleSlide.addText(content.title, { x: 0.5, y: 2.5, w: 12, h: 1.5, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center' });
  titleSlide.addText(content.metadata?.date ?? new Date().toLocaleDateString(), { x: 0.5, y: 4.2, w: 12, h: 0.5, fontSize: 18, color: 'AED6F1', align: 'center' });
  titleSlide.addText('Generated by Artha', { x: 0.5, y: 6.5, w: 12, h: 0.3, fontSize: 12, color: '7FB3D3', align: 'center' });
  titleSlide.addNotes(`[artha-anchor:${content.titleAnchor}]`);

  for (const section of content.sections) {
    const slide = pptx.addSlide();
    slide.addText(section.heading, { x: 0.4, y: 0.3, w: 12, h: 0.8, fontSize: 28, bold: true, color: '1B4F72' });
    slide.addShape(pptx.ShapeType.line, { x: 0.4, y: 1.1, w: 12, h: 0, line: { color: '2E86C1', width: 2 } });

    if (section.bullets?.length) {
      const bulletText = section.bullets.map(b => ({ text: b, options: { bullet: true, fontSize: 18, color: '1A252F', paraSpaceBefore: 6 } }));
      slide.addText(bulletText, { x: 0.5, y: 1.3, w: 11.5, h: 5 });
    } else if (section.body) {
      slide.addText(section.body, { x: 0.5, y: 1.3, w: 11.5, h: 5, fontSize: 18, color: '1A252F', valign: 'top', wrap: true });
    }

    if (section.table) {
      const tableData = [
        section.table.headers.map(h => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: '1B4F72' } } })),
        ...section.table.rows.map(row => row.map(cell => ({ text: cell }))),
      ];
      slide.addTable(tableData, { x: 0.5, y: 1.3, w: 12, fontSize: 14 });
    }

    slide.addNotes(`[artha-anchor:${section.anchor}] source=${section.provenance.type}:${section.provenance.ref}`);
  }

  await pptx.writeFile({ fileName: outPath });
  return outPath;
}

// ── XLSX Generator ──────────────────────────────────────────────────────────
// One sheet per section. Anchor markers live in row 2 so they sit just below
// the heading and don't interfere with data rows below. Sheet names are
// sanitised to Excel's 31-char limit and stripped of `\/:*?[]`.

/** Build a multi-sheet `.xlsx` and write it to `outPath`. */
async function generateXlsx(content: AnchoredContent, outPath: string): Promise<string> {
  const wb = XLSX.utils.book_new();

  for (const section of content.sections) {
    const rows: unknown[][] = [];
    rows.push([section.heading]);
    rows.push([`[artha-anchor:${section.anchor}] source=${section.provenance.type}:${section.provenance.ref}`]);
    rows.push([]);

    if (section.table) {
      rows.push(section.table.headers);
      rows.push(...section.table.rows);
    } else if (section.bullets?.length) {
      for (const b of section.bullets) rows.push([b]);
    } else if (section.body) {
      rows.push([section.body]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const safeName = section.heading.replace(/[\\/:*?[\]]/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName || 'Sheet');
  }

  // Write via a buffer rather than XLSX.writeFile: the SheetJS CDN build is
  // ESM and does not auto-wire Node's fs, so writeFile/readFile throw. Going
  // through fs ourselves is build-agnostic and avoids the global set_fs hook.
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// ── PDF Generator ───────────────────────────────────────────────────────────
// Minimal pdf-lib rendering: cover title + headings + wrapped paragraph
// bodies + bulleted lists. Anchor IDs are stashed in the PDF Subject + Keywords
// metadata so the receipt can correlate sections without bookmarks.

/** Build a letter-size `.pdf` and write it to `outPath`. */
async function generatePdf(content: AnchoredContent, outPath: string): Promise<string> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(content.title);
  pdfDoc.setSubject(`artha-doc:${content.titleAnchor}`);
  pdfDoc.setKeywords(content.sections.map(s => `anchor:${s.anchor}`));

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const addPage = () => {
    const page = pdfDoc.addPage([612, 792]);
    return { page, y: 740 };
  };

  let { page, y } = addPage();
  const margin = 72;
  const lineH = 16;

  const writeLine = (text: string, size: number, isBold = false, color = rgb(0, 0, 0)) => {
    if (y < margin + 40) { const np = addPage(); page = np.page; y = np.y; }
    page.drawText(text.slice(0, 90), { x: margin, y, size, font: isBold ? boldFont : font, color });
    y -= lineH * (size / 12);
  };

  writeLine(content.title, 24, true, rgb(0.11, 0.31, 0.45));
  y -= 10;
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 1, color: rgb(0.18, 0.53, 0.76) });
  y -= 20;

  for (const section of content.sections) {
    writeLine(section.heading, 16, true, rgb(0.11, 0.31, 0.45));
    y -= 4;
    if (section.body) {
      const words = section.body.split(' ');
      let line = '';
      for (const word of words) {
        if ((line + word).length > 80) { writeLine(line, 11); line = word + ' '; }
        else line += word + ' ';
      }
      if (line.trim()) writeLine(line, 11);
    }
    if (section.bullets) for (const b of section.bullets) writeLine(`  • ${b}`, 11);
    y -= 10;
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outPath, pdfBytes);
  return outPath;
}

// ── Provenance registration ─────────────────────────────────────────────────

/** Internal arg bag for `registerProvenance()`. */
interface RegisterArgs {
  filePath: string;
  docType: DocType;
  title: string;
  prompt: string;
  model: string;
  sessionId?: string;
  content: AnchoredContent;
}

/** Hash the on-disk artifact, write a sibling `.artha-receipt.json`, and insert
 *  one `generated_documents` row plus one `provenance_records` row per anchor.
 *  Database writes are wrapped in a transaction so a mid-insert crash never
 *  leaves a half-anchored doc. */
function registerProvenance(args: RegisterArgs): GenerateResult {
  const db = getDb();
  const fileBuf = fs.readFileSync(args.filePath);
  const contentHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
  const promptHash = crypto.createHash('sha256').update(args.prompt).digest('hex');
  const docId = crypto.randomUUID();
  const receiptPath = args.filePath + '.artha-receipt.json';

  const anchors = [
    { anchor: args.content.titleAnchor, type: 'llm' as const, ref: 'title', excerpt: args.title },
    ...args.content.sections.map(s => ({
      anchor: s.anchor,
      type: s.provenance.type,
      ref: s.provenance.ref,
      excerpt: s.provenance.excerpt,
    })),
  ];

  const receipt = {
    schema: 'artha-receipt/v1',
    docId,
    filePath: args.filePath,
    docType: args.docType,
    title: args.title,
    prompt: args.prompt,
    promptHash,
    contentHash,
    model: args.model,
    createdAt: new Date().toISOString(),
    anchors,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

  try {
    db.prepare(`
      INSERT INTO generated_documents
        (doc_id, session_id, file_path, doc_type, title, prompt, prompt_hash, content_hash, model, receipt_path)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      docId, args.sessionId ?? null, args.filePath, args.docType,
      args.title, args.prompt, promptHash, contentHash, args.model, receiptPath
    );

    const insertAnchor = db.prepare(`
      INSERT INTO provenance_records (doc_id, anchor_id, source_type, source_ref, excerpt)
      VALUES (?,?,?,?,?)
    `);
    const tx = db.transaction((rows: typeof anchors) => {
      for (const a of rows) insertAnchor.run(docId, a.anchor, a.type, a.ref, a.excerpt);
    });
    tx(anchors);
  } catch (err) {
    console.warn('[Artha] Provenance registration failed:', err);
  }

  return { filePath: args.filePath, docId, receiptPath, contentHash, anchors: anchors.length };
}
