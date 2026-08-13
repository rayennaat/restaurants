/**
 * CSV reading and writing.
 *
 * Pure: a string in, rows out. No file handles, no streams, no I/O — so the
 * awkward cases below are asserted directly in `csv.test.ts` rather than
 * through a fixture file, and the same function runs in the browser (to preview
 * a file the user just picked) and on the server (to import the file it is
 * authoritative about).
 *
 * Written by hand rather than pulled from npm because the requirement is narrow
 * and the failure modes are specific to what point-of-sale systems actually
 * export:
 *
 *   * **Semicolons.** A French or Tunisian POS exporting through Excel writes
 *     `18,500;2;Burger` — comma is the decimal separator, so semicolon is the
 *     delimiter. Assuming a comma would silently split every price in half.
 *   * **A byte-order mark.** Excel prepends one to "CSV UTF-8", which turns the
 *     first header into `﻿Date` and makes column detection miss it.
 *   * **Quoted fields containing the delimiter and newlines.** `"Burger, large"`
 *     is one cell; a note field may legitimately wrap lines.
 *   * **Ragged rows.** Trailing summary lines ("Total,,,1234") are common and
 *     must be reported rather than quietly shifting every value one column left.
 *
 * Malformed input throws {@link CsvParseError}. That is deliberate: a file whose
 * quoting does not close cannot be interpreted, and guessing at it would import
 * plausible nonsense.
 */

/** Delimiters worth sniffing for, most likely first. */
const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

export type CsvDelimiter = (typeof CANDIDATE_DELIMITERS)[number];

export class CsvParseError extends Error {
  /** 1-based source line, so the message can point at something the user can see. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "CsvParseError";
    this.line = line;
  }
}

export type RaggedRow = {
  /** 1-based line in the source file, counting the header. */
  line: number;
  cells: number;
};

export type CsvTable = {
  /** First row, trimmed and BOM-stripped. Empty when the file has no content. */
  headers: string[];
  /** Data rows, header excluded, each padded or trimmed to `headers.length`. */
  rows: string[][];
  delimiter: CsvDelimiter;
  /** Rows whose raw cell count disagreed with the header, before padding. */
  ragged: RaggedRow[];
  /** True when `maxRows` cut the file short. */
  truncated: boolean;
  /** Data rows present in the file, even if `rows` was truncated. */
  totalRows: number;
};

/** Strips the UTF-8 BOM Excel writes, which otherwise corrupts the first header. */
function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guesses the delimiter from the first few lines.
 *
 * Counts candidates outside quoted regions and takes the most frequent, then
 * prefers the one whose count is *consistent* across lines — a comma appearing
 * twice on every line is a delimiter, whereas one appearing 5 times then 0 times
 * is decimal punctuation. Ties fall back to the candidate order above, so a
 * plain comma-separated file needs no cleverness at all.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = stripBom(text)
    .split(/\r\n|\n|\r/)
    .filter(line => line.trim() !== "")
    .slice(0, 5);
  if (!lines.length) return ",";

  let best: CsvDelimiter = ",";
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map(line => countOutsideQuotes(line, delimiter));
    const total = counts.reduce((sum, n) => sum + n, 0);
    if (total === 0) continue;

    // Consistency across lines is what separates a delimiter from punctuation.
    const first = counts[0];
    const consistent = counts.every(count => count === first) ? 1 : 0;
    const score = total + consistent * 100;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

function countOutsideQuotes(line: string, delimiter: string) {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

export type ParseCsvOptions = {
  /** Overrides sniffing when the user has picked a delimiter by hand. */
  delimiter?: CsvDelimiter;
  /**
   * Stop after this many data rows. The preview reads a slice of a large file
   * without holding the whole thing in memory twice; `totalRows` still reports
   * the true count so the UI can say "showing 100 of 40,000".
   */
  maxRows?: number;
};

/**
 * Tokenizes CSV text into rows of raw cells, following RFC 4180.
 *
 * A single pass over the string with an explicit quoted/unquoted state, which
 * is what makes embedded delimiters, embedded newlines and escaped quotes
 * (`""`) fall out naturally instead of needing special cases. Line endings are
 * normalized here rather than by pre-replacing them, so a CRLF *inside* a
 * quoted cell survives as the author wrote it.
 */
function tokenize(text: string, delimiter: string, rowLimit: number): { rows: string[][]; totalRows: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldWasQuoted = false;
  let line = 1;
  let total = 0;

  const endField = () => {
    // Unquoted whitespace is padding from a hand-edited file; quoted whitespace
    // was asked for. Trimming only the former keeps `"  "` meaningful.
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  };

  const endRow = () => {
    endField();
    // A blank line is separation, not a record. Skipping it here means a file
    // ending in a newline does not produce a phantom trailing row.
    const empty = row.length === 1 && row[0] === "";
    if (!empty) {
      total += 1;
      if (rows.length < rowLimit) rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      // A quote after content ("mid"field) is malformed in strict RFC 4180. It
      // is taken literally instead: real exports contain stray inch marks, and
      // rejecting the whole file over one would be unhelpful.
      if (field === "") {
        quoted = true;
        fieldWasQuoted = true;
      } else {
        field += char;
      }
      continue;
    }

    if (char === delimiter) {
      endField();
      continue;
    }

    if (char === "\r") {
      // CRLF or a lone CR; both end the record.
      if (text[i + 1] === "\n") i += 1;
      line += 1;
      endRow();
      continue;
    }

    if (char === "\n") {
      line += 1;
      endRow();
      continue;
    }

    field += char;
  }

  if (quoted) {
    throw new CsvParseError(
      "A quoted value is never closed — check for a stray double quote (\").",
      line,
    );
  }

  // Trailing content with no final newline is still a row.
  if (field !== "" || row.length > 0) endRow();

  return { rows, totalRows: total };
}

/**
 * Parses CSV text into a header row and data rows.
 *
 * Rows are normalized to the header's width: short rows are padded with empty
 * strings and long rows are cut. Both cases are reported in `ragged` rather than
 * fixed silently — a file whose rows do not line up usually means the wrong
 * delimiter was detected or a summary line is attached at the bottom, and the
 * user needs to be told which.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvTable {
  const content = stripBom(text);
  const delimiter = options.delimiter ?? detectDelimiter(content);
  const rowLimit = options.maxRows ?? Number.POSITIVE_INFINITY;

  if (content.trim() === "") {
    return { headers: [], rows: [], delimiter, ragged: [], truncated: false, totalRows: 0 };
  }

  // One extra row so the header can be taken off the front without costing a
  // data row against the caller's limit.
  const { rows: allRows, totalRows } = tokenize(content, delimiter, rowLimit === Number.POSITIVE_INFINITY ? rowLimit : rowLimit + 1);
  if (!allRows.length) {
    return { headers: [], rows: [], delimiter, ragged: [], truncated: false, totalRows: 0 };
  }

  const headers = allRows[0].map(header => header.trim());
  const width = headers.length;
  const ragged: RaggedRow[] = [];

  const rows = allRows.slice(1).map((cells, index) => {
    if (cells.length !== width) {
      // +2: one for the header row, one to make the number 1-based.
      ragged.push({ line: index + 2, cells: cells.length });
    }
    if (cells.length === width) return cells;
    if (cells.length > width) return cells.slice(0, width);
    return [...cells, ...Array(width - cells.length).fill("")];
  });

  const dataRows = Math.max(totalRows - 1, 0);

  return {
    headers,
    rows,
    delimiter,
    ragged,
    truncated: dataRows > rows.length,
    totalRows: dataRows,
  };
}

/** Quotes a cell only when it would otherwise change meaning. */
function quoteCell(value: string, delimiter: string) {
  const needsQuotes = value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value);
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serializes rows back to CSV, for the downloadable error report.
 *
 * Always comma-delimited and always CRLF-terminated with a BOM: the file exists
 * to be opened in Excel, and that combination is what makes Excel read UTF-8
 * accented text correctly instead of mangling it.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const body = rows
    .map(row => row.map(cell => quoteCell(cell === null || cell === undefined ? "" : String(cell), ",")).join(","))
    .join("\r\n");
  return `﻿${body}\r\n`;
}
