/**
 * qrcode.ts — Dependency-free QR Code generator (pure TypeScript, zero imports).
 *
 * Implements the QR Code symbol generation pipeline from scratch:
 *   - BYTE (8-bit) mode encoding only (suitable for ASCII/Latin-1 URLs).
 *   - Reed-Solomon error correction over GF(256) with primitive polynomial 0x11D,
 *     generator polynomial built from successive roots (alpha^0..alpha^(n-1)).
 *   - Block interleaving for versions/EC levels that use multiple EC blocks.
 *   - Function patterns: finder patterns + separators, timing patterns,
 *     alignment patterns, the dark module, format information (BCH(15,5),
 *     mask 0x5412) and version information (BCH(18,6)) for versions >= 7.
 *   - All 8 data mask patterns evaluated with the four standard penalty rules;
 *     the lowest-penalty mask is selected.
 *
 * Supported: QR versions 1 through 10 at EC level M (medium, ~15% recovery).
 * Capacity at v10 / level M in byte mode is 271 bytes, but a hard guard rejects
 * input that does not fit version 10. Comfortably handles short ASCII URLs.
 *
 * No external dependencies and no imports of any kind.
 */

// ---------------------------------------------------------------------------
// GF(256) arithmetic (primitive polynomial 0x11D)
// ---------------------------------------------------------------------------

const GF_EXP: number[] = new Array<number>(512).fill(0);
const GF_LOG: number[] = new Array<number>(256).fill(0);

(function initGaloisField(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  // Extend exp table to simplify multiplication without modulo.
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// ---------------------------------------------------------------------------
// Reed-Solomon error correction
// ---------------------------------------------------------------------------

/** Build the generator polynomial of degree `ecLen` (coefficients, high to low). */
function rsGeneratorPoly(ecLen: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < ecLen; i++) {
    // Multiply poly by (x - alpha^i) == (x + alpha^i) in GF(256).
    const next: number[] = new Array<number>(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], root);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  // `poly` is built low-to-high (index == power of x). Reverse to high-to-low
  // so poly[0] is the leading (monic) coefficient 1, matching rsEncode below.
  poly.reverse();
  return poly;
}

/** Compute `ecLen` Reed-Solomon error-correction codewords for `data`. */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  // Polynomial division remainder. `gen` has length ecLen+1 with leading 1.
  const remainder: number[] = new Array<number>(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    // Shift remainder left by one.
    for (let j = 0; j < ecLen - 1; j++) {
      remainder[j] = remainder[j + 1];
    }
    remainder[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        // gen[j+1] because gen[0] is the leading 1 we already accounted for.
        remainder[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Spec tables (versions 1..10, EC level M)
// ---------------------------------------------------------------------------

interface EcSpec {
  /** Total data codewords for the whole symbol at this version/EC level. */
  totalDataCodewords: number;
  /** EC codewords per block. */
  ecCodewordsPerBlock: number;
  /** Block group definitions: [numBlocks, dataCodewordsPerBlock]. */
  groups: Array<[numBlocks: number, dataPerBlock: number]>;
}

// EC level M tables. Source: ISO/IEC 18004 capacity tables.
const EC_TABLE_M: Record<number, EcSpec> = {
  1: { totalDataCodewords: 16, ecCodewordsPerBlock: 10, groups: [[1, 16]] },
  2: { totalDataCodewords: 28, ecCodewordsPerBlock: 16, groups: [[1, 28]] },
  3: { totalDataCodewords: 44, ecCodewordsPerBlock: 26, groups: [[1, 44]] },
  4: { totalDataCodewords: 64, ecCodewordsPerBlock: 18, groups: [[2, 32]] },
  5: { totalDataCodewords: 86, ecCodewordsPerBlock: 24, groups: [[2, 43]] },
  6: { totalDataCodewords: 108, ecCodewordsPerBlock: 16, groups: [[4, 27]] },
  7: { totalDataCodewords: 124, ecCodewordsPerBlock: 18, groups: [[4, 31]] },
  8: { totalDataCodewords: 154, ecCodewordsPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { totalDataCodewords: 182, ecCodewordsPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { totalDataCodewords: 216, ecCodewordsPerBlock: 26, groups: [[4, 43], [1, 44]] },
};

/** Alignment-pattern center coordinates per version (excluding those that
 * collide with finder patterns; pairing is the cartesian product). */
const ALIGNMENT_POSITIONS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;

function versionSize(version: number): number {
  return version * 4 + 17;
}

// ---------------------------------------------------------------------------
// Bit buffer helper
// ---------------------------------------------------------------------------

class BitBuffer {
  private readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pack accumulated bits into bytes (MSB-first), padding with zero bits. */
  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | (i + j < this.bits.length ? this.bits[i + j] : 0);
      }
      bytes.push(b);
    }
    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Data encoding (byte mode)
// ---------------------------------------------------------------------------

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // Handle surrogate pairs.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

/** Character-count indicator length (bits) for byte mode by version range. */
function byteModeCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Choose smallest version (1..10) whose data capacity fits `dataLen` bytes. */
function chooseVersion(dataLen: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const spec = EC_TABLE_M[v];
    const countBits = byteModeCountBits(v);
    // Total data bits available = totalDataCodewords * 8.
    // Overhead = mode indicator (4 bits) + char count indicator.
    const needBits = 4 + countBits + dataLen * 8;
    if (needBits <= spec.totalDataCodewords * 8) {
      return v;
    }
  }
  throw new Error(
    `Data too long for QR version ${MAX_VERSION} (level M, byte mode): ${dataLen} bytes`,
  );
}

/** Build the final data codeword stream (data + padding) for the version. */
function buildDataCodewords(data: number[], version: number): number[] {
  const spec = EC_TABLE_M[version];
  const totalDataCodewords = spec.totalDataCodewords;
  const countBits = byteModeCountBits(version);

  const buf = new BitBuffer();
  buf.put(0b0100, 4); // BYTE mode indicator.
  buf.put(data.length, countBits);
  for (const b of data) {
    buf.put(b, 8);
  }

  const capacityBits = totalDataCodewords * 8;
  // Terminator: up to 4 zero bits.
  const remaining = capacityBits - buf.length;
  buf.put(0, Math.min(4, remaining));

  const codewords = buf.toBytes();
  // Pad bytes alternate between 0xEC and 0x11.
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < totalDataCodewords) {
    codewords.push(padBytes[padIndex % 2]);
    padIndex++;
  }
  return codewords;
}

/** Split data codewords into blocks, compute EC, and interleave. */
function buildFinalCodewords(dataCodewords: number[], version: number): number[] {
  const spec = EC_TABLE_M[version];
  const ecLen = spec.ecCodewordsPerBlock;

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (const [numBlocks, dataPerBlock] of spec.groups) {
    for (let b = 0; b < numBlocks; b++) {
      const block = dataCodewords.slice(offset, offset + dataPerBlock);
      offset += dataPerBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  }

  const result: number[] = [];

  // Interleave data codewords.
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        result.push(block[i]);
      }
    }
  }

  // Interleave EC codewords (all EC blocks have equal length).
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) {
      result.push(block[i]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

type Cell = boolean | null;

interface Matrix {
  size: number;
  modules: Cell[][];
  reserved: boolean[][];
}

function createMatrix(version: number): Matrix {
  const size = versionSize(version);
  const modules: Cell[][] = [];
  const reserved: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    modules.push(new Array<Cell>(size).fill(null));
    reserved.push(new Array<boolean>(size).fill(false));
  }
  return { size, modules, reserved };
}

function setFunction(m: Matrix, r: number, c: number, dark: boolean): void {
  m.modules[r][c] = dark;
  m.reserved[r][c] = true;
}

function placeFinderPattern(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) {
        continue;
      }
      const inRing =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setFunction(m, rr, cc, inRing || inCore);
    }
  }
}

function placeFinderPatterns(m: Matrix): void {
  placeFinderPattern(m, 0, 0);
  placeFinderPattern(m, 0, m.size - 7);
  placeFinderPattern(m, m.size - 7, 0);
}

function placeTimingPatterns(m: Matrix): void {
  for (let i = 8; i < m.size - 8; i++) {
    const dark = i % 2 === 0;
    if (!m.reserved[6][i]) {
      setFunction(m, 6, i, dark);
    }
    if (!m.reserved[i][6]) {
      setFunction(m, i, 6, dark);
    }
  }
}

function placeAlignmentPatterns(m: Matrix, version: number): void {
  const positions = ALIGNMENT_POSITIONS[version];
  for (const cy of positions) {
    for (const cx of positions) {
      // Skip the three corners overlapping finder patterns.
      const overlapsFinder =
        (cy === 6 && cx === 6) ||
        (cy === 6 && cx === m.size - 7) ||
        (cy === m.size - 7 && cx === 6);
      if (overlapsFinder) {
        continue;
      }
      // Alignment patterns may legitimately overlap the timing patterns
      // (e.g. center on row/col 6); they take precedence and are drawn fully.
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          const dark = ring !== 1; // dark at center (0) and outer ring (2).
          setFunction(m, cy + r, cx + c, dark);
        }
      }
    }
  }
}

function reserveFormatAndVersion(m: Matrix, version: number): void {
  // Reserve format-information areas (filled later with real bits).
  for (let i = 0; i < 9; i++) {
    if (!m.reserved[8][i]) {
      m.reserved[8][i] = true;
      m.modules[8][i] = false;
    }
    if (!m.reserved[i][8]) {
      m.reserved[i][8] = true;
      m.modules[i][8] = false;
    }
  }
  for (let i = 0; i < 8; i++) {
    const r = m.size - 1 - i;
    if (!m.reserved[r][8]) {
      m.reserved[r][8] = true;
      m.modules[r][8] = false;
    }
    const c = m.size - 1 - i;
    if (!m.reserved[8][c]) {
      m.reserved[8][c] = true;
      m.modules[8][c] = false;
    }
  }

  // Dark module.
  setFunction(m, m.size - 8, 8, true);

  // Reserve version-information areas for v >= 7.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        // Bottom-left 6x3 block.
        m.reserved[m.size - 11 + j][i] = true;
        m.modules[m.size - 11 + j][i] = false;
        // Top-right 3x6 block.
        m.reserved[i][m.size - 11 + j] = true;
        m.modules[i][m.size - 11 + j] = false;
      }
    }
  }
}

/** Place data bits in the zig-zag pattern over unreserved modules. */
function placeData(m: Matrix, codewords: number[]): void {
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) {
      bits.push((cw >>> i) & 1);
    }
  }

  let bitIndex = 0;
  let upward = true;
  // Iterate column pairs from right to left. The vertical timing column (index 6)
  // is not a data column; shift left by one once we pass it.
  for (let right = m.size - 1; right > 0; right -= 2) {
    const colRight = right <= 6 ? right - 1 : right;
    for (let i = 0; i < m.size; i++) {
      const row = upward ? m.size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const cc = colRight - dc;
        if (cc < 0 || m.reserved[row][cc]) {
          continue;
        }
        const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
        m.modules[row][cc] = bit === 1;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

function maskCondition(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(m: Matrix, mask: number): boolean[][] {
  const out: boolean[][] = [];
  for (let r = 0; r < m.size; r++) {
    const rowArr: boolean[] = new Array<boolean>(m.size).fill(false);
    for (let c = 0; c < m.size; c++) {
      let val = m.modules[r][c] === true;
      if (!m.reserved[r][c] && maskCondition(mask, r, c)) {
        val = !val;
      }
      rowArr[c] = val;
    }
    out.push(rowArr);
  }
  return out;
}

function penaltyScore(grid: boolean[][]): number {
  const n = grid.length;
  let score = 0;

  // Rule 1: runs of 5+ same-color modules in rows and columns.
  for (let r = 0; r < n; r++) {
    let runColor = grid[r][0];
    let runLen = 1;
    for (let c = 1; c < n; c++) {
      if (grid[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) {
          score += 3 + (runLen - 5);
        }
        runColor = grid[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) {
      score += 3 + (runLen - 5);
    }
  }
  for (let c = 0; c < n; c++) {
    let runColor = grid[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (grid[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) {
          score += 3 + (runLen - 5);
        }
        runColor = grid[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) {
      score += 3 + (runLen - 5);
    }
  }

  // Rule 2: 2x2 blocks of the same color.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (grid[r][c + 1] === v && grid[r + 1][c] === v && grid[r + 1][c + 1] === v) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like patterns 1:1:3:1:1 with 4-module light run on either side.
  const pattern1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pattern2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matchAt = (
    get: (i: number) => boolean,
    start: number,
    pat: boolean[],
  ): boolean => {
    for (let k = 0; k < pat.length; k++) {
      if (get(start + k) !== pat[k]) {
        return false;
      }
    }
    return true;
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n - 11; c++) {
      const get = (i: number): boolean => grid[r][i];
      if (matchAt(get, c, pattern1) || matchAt(get, c, pattern2)) {
        score += 40;
      }
    }
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r <= n - 11; r++) {
      const get = (i: number): boolean => grid[i][c];
      if (matchAt(get, r, pattern1) || matchAt(get, r, pattern2)) {
        score += 40;
      }
    }
  }

  // Rule 4: deviation of dark-module proportion from 50%.
  let dark = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) {
        dark++;
      }
    }
  }
  const total = n * n;
  const percent = (dark * 100) / total;
  const prev = Math.floor(percent / 5) * 5;
  const next = prev + 5;
  const dev = Math.min(Math.abs(prev - 50), Math.abs(next - 50));
  score += (dev / 5) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// Format & version information (BCH)
// ---------------------------------------------------------------------------

/** Compute 15-bit format info for EC level M and given mask, XOR'd with mask. */
function formatInfoBits(mask: number): number {
  // EC level M => 2-bit indicator 0b00.
  const data = (0b00 << 3) | mask; // 5 bits.
  // BCH(15,5), generator 0b10100110111 (0x537).
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) {
      rem ^= g << (i - 10);
    }
  }
  const bits = ((data << 10) | rem) ^ 0b101010000010010; // mask 0x5412.
  return bits & 0x7fff;
}

/** Place 15-bit format info into the two standard locations. */
function placeFormatInfo(grid: boolean[][], m: Matrix, mask: number): void {
  const bits = formatInfoBits(mask);
  const n = grid.length;
  // The 15-bit value is placed MSB-first: index 0 -> bit 14 (MSB) ... index 14 -> bit 0.
  const get = (i: number): boolean => ((bits >> (14 - i)) & 1) === 1;

  // First copy: around the top-left finder.
  for (let i = 0; i <= 5; i++) {
    grid[8][i] = get(i);
  }
  grid[8][7] = get(6);
  grid[8][8] = get(7);
  grid[7][8] = get(8);
  for (let i = 9; i < 15; i++) {
    grid[14 - i][8] = get(i);
  }

  // Second copy: bottom-left (vertical) and top-right (horizontal).
  for (let i = 0; i < 8; i++) {
    grid[n - 1 - i][8] = get(i);
  }
  for (let i = 8; i < 15; i++) {
    grid[8][n - 15 + i] = get(i);
  }

  // Dark module.
  grid[n - 8][8] = true;
  void m;
}

/** Compute 18-bit version info (BCH(18,6)) for version >= 7. */
function versionInfoBits(version: number): number {
  let rem = version << 12;
  const g = 0b1111100100101; // 0x1F25.
  for (let i = 17; i >= 12; i--) {
    if (rem & (1 << i)) {
      rem ^= g << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function placeVersionInfo(grid: boolean[][], version: number): void {
  if (version < 7) {
    return;
  }
  const n = grid.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    // Bottom-left 6x3 block.
    grid[n - 11 + c][r] = bit;
    // Top-right 3x6 block.
    grid[r][n - 11 + c] = bit;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a QR code module matrix for `text` (byte mode, EC level M).
 * Returns a square matrix where `true` is a dark module and `false` is light.
 * Throws if the text does not fit within QR version 10.
 */
export function generateQrMatrix(text: string): boolean[][] {
  const data = utf8Bytes(text);
  const version = chooseVersion(data.length);

  const dataCodewords = buildDataCodewords(data, version);
  const finalCodewords = buildFinalCodewords(dataCodewords, version);

  // Build the base matrix with function patterns and reserved regions.
  const base = createMatrix(version);
  placeFinderPatterns(base);
  // Separators are implicitly the light ring drawn by placeFinderPattern's r/c = -1..7
  // boundary; ensure separator cells are reserved light.
  placeSeparators(base);
  placeTimingPatterns(base);
  placeAlignmentPatterns(base, version);
  reserveFormatAndVersion(base, version);
  placeData(base, finalCodewords);

  // Evaluate all 8 masks; pick the lowest penalty.
  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid: boolean[][] | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = applyMask(base, mask);
    placeFormatInfo(grid, base, mask);
    placeVersionInfo(grid, version);
    const score = penaltyScore(grid);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = grid;
    }
  }

  if (bestGrid === null) {
    // Unreachable, but keeps the type checker satisfied.
    const grid = applyMask(base, bestMask);
    placeFormatInfo(grid, base, bestMask);
    placeVersionInfo(grid, version);
    return grid;
  }
  return bestGrid;
}

function placeSeparators(m: Matrix): void {
  const n = m.size;
  const reserveLight = (r: number, c: number): void => {
    if (r < 0 || r >= n || c < 0 || c >= n) {
      return;
    }
    if (!m.reserved[r][c]) {
      setFunction(m, r, c, false);
    }
  };
  // Top-left separator.
  for (let i = 0; i <= 7; i++) {
    reserveLight(7, i);
    reserveLight(i, 7);
  }
  // Top-right separator.
  for (let i = 0; i <= 7; i++) {
    reserveLight(7, n - 1 - i);
    reserveLight(i, n - 8);
  }
  // Bottom-left separator.
  for (let i = 0; i <= 7; i++) {
    reserveLight(n - 8, i);
    reserveLight(n - 1 - i, 7);
  }
}

/**
 * Render `text` as a complete SVG QR code string.
 * Dark modules are combined into a single `<path>` `d` attribute for compactness.
 */
export function qrToSvg(
  text: string,
  options?: { moduleSize?: number; margin?: number; dark?: string; light?: string },
): string {
  const moduleSize = options?.moduleSize ?? 4;
  const margin = options?.margin ?? 4;
  const dark = options?.dark ?? '#000000';
  const light = options?.light ?? '#ffffff';

  const matrix = generateQrMatrix(text);
  const count = matrix.length;
  const dim = (count + margin * 2) * moduleSize;

  let path = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (matrix[r][c]) {
        const x = (c + margin) * moduleSize;
        const y = (r + margin) * moduleSize;
        path += `M${x} ${y}h${moduleSize}v${moduleSize}h${-moduleSize}z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
