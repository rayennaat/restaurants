import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, toCsv, CsvParseError } from "@/lib/csv";

/**
 * CSV reading.
 *
 * The cases here are the ones that actually break imports: a semicolon-delimited
 * European export, an Excel byte-order mark, a quoted field containing the
 * delimiter, and a trailing summary line that does not line up with the header.
 * Each of those fails *silently* if mishandled — the file parses, the numbers are
 * simply wrong — which is why they are pinned individually rather than covered by
 * one happy-path fixture.
 */

describe("delimiter detection", () => {
  it("finds commas in a plain file", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("finds semicolons when the decimal separator is a comma", () => {
    // The failure this prevents: reading "18,500" as two columns and halving
    // every price in a French or Tunisian export.
    expect(detectDelimiter("Date;Article;Prix\n01/02/2025;Burger;18,500")).toBe(";");
  });

  it("finds tabs", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("finds pipes", () => {
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
  });

  it("prefers the delimiter with a consistent count per line", () => {
    // Commas appear more often overall, but only the semicolon count is stable.
    expect(detectDelimiter("a;b\n1,50;2,75\n3,10;4,20")).toBe(";");
  });

  it("ignores delimiters inside quotes", () => {
    expect(detectDelimiter('name;total\n"Burger, large";2')).toBe(";");
  });

  it("falls back to comma for a single column", () => {
    expect(detectDelimiter("total\n5")).toBe(",");
  });
});

describe("parsing", () => {
  it("reads headers and rows", () => {
    const table = parseCsv("Date,Item,Qty\n2025-01-01,Burger,2\n2025-01-02,Fries,3");
    expect(table.headers).toEqual(["Date", "Item", "Qty"]);
    expect(table.rows).toEqual([
      ["2025-01-01", "Burger", "2"],
      ["2025-01-02", "Fries", "3"],
    ]);
    expect(table.totalRows).toBe(2);
  });

  it("strips the byte-order mark Excel writes", () => {
    // Left in place, the first header becomes "﻿Date" and never matches.
    const table = parseCsv("﻿Date,Item\n2025-01-01,Burger");
    expect(table.headers[0]).toBe("Date");
  });

  it("keeps a quoted delimiter inside one cell", () => {
    const table = parseCsv('Item,Qty\n"Burger, large",2');
    expect(table.rows[0]).toEqual(["Burger, large", "2"]);
  });

  it("unescapes doubled quotes", () => {
    const table = parseCsv('Item\n"12"" pizza"');
    expect(table.rows[0]).toEqual(['12" pizza']);
  });

  it("keeps a newline inside a quoted cell", () => {
    const table = parseCsv('Item,Note\nBurger,"line one\nline two"');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][1]).toBe("line one\nline two");
  });

  it("handles CRLF line endings", () => {
    const table = parseCsv("Date,Item\r\n2025-01-01,Burger\r\n2025-01-02,Fries\r\n");
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual(["2025-01-02", "Fries"]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n").rows).toHaveLength(1);
  });

  it("skips blank lines between records", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4\n").rows).toHaveLength(2);
  });

  it("reads a final row with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([["1", "2"]]);
  });

  it("trims unquoted padding but keeps quoted whitespace", () => {
    const table = parseCsv('a,b\n  x  ,"  y  "');
    expect(table.rows[0]).toEqual(["x", "  y  "]);
  });

  it("pads a short row and reports it as ragged", () => {
    // The alternative — leaving the row short — shifts every later column read.
    const table = parseCsv("a,b,c\n1,2");
    expect(table.rows[0]).toEqual(["1", "2", ""]);
    expect(table.ragged).toEqual([{ line: 2, cells: 2 }]);
  });

  it("truncates a long row and reports it as ragged", () => {
    // The shape of a trailing "Total,,,,1234" summary line.
    const table = parseCsv("a,b\n1,2,3");
    expect(table.rows[0]).toEqual(["1", "2"]);
    expect(table.ragged[0].line).toBe(2);
  });

  it("numbers ragged rows the way a spreadsheet does", () => {
    const table = parseCsv("a,b\n1,2\n3");
    // Header is line 1, so the first data row is line 2.
    expect(table.ragged).toEqual([{ line: 3, cells: 1 }]);
  });

  it("honours an explicit delimiter over sniffing", () => {
    const table = parseCsv("a;b\n1;2", { delimiter: ";" });
    expect(table.headers).toEqual(["a", "b"]);
  });

  it("stops at maxRows but still reports the true total", () => {
    const text = ["a", ...Array.from({ length: 50 }, (_, index) => String(index))].join("\n");
    const table = parseCsv(text, { maxRows: 10 });
    expect(table.rows).toHaveLength(10);
    expect(table.totalRows).toBe(50);
    expect(table.truncated).toBe(true);
  });

  it("returns nothing for an empty file", () => {
    const table = parseCsv("   \n  ");
    expect(table.headers).toEqual([]);
    expect(table.rows).toEqual([]);
  });

  it("reads a header-only file as zero rows", () => {
    const table = parseCsv("Date,Item,Qty\n");
    expect(table.headers).toHaveLength(3);
    expect(table.rows).toEqual([]);
  });
});

describe("malformed input", () => {
  it("rejects an unterminated quote instead of guessing", () => {
    // Everything after the stray quote would otherwise be swallowed into one
    // cell, producing a plausible-looking file with the wrong contents.
    expect(() => parseCsv('Item,Qty\n"Burger,2\nFries,3')).toThrow(CsvParseError);
  });

  it("names the line the quoting problem was detected on", () => {
    try {
      parseCsv('Item\n"open\nstill open\nmore');
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      expect((error as CsvParseError).line).toBeGreaterThan(1);
    }
  });

  it("takes a stray mid-field quote literally rather than failing the file", () => {
    // Real exports contain inch marks; rejecting the whole upload over one
    // would be unhelpful when the intent is unambiguous.
    const table = parseCsv('Item,Qty\n12" pizza,2');
    expect(table.rows[0]).toEqual(['12" pizza', "2"]);
  });
});

describe("writing", () => {
  it("quotes only what needs quoting", () => {
    expect(toCsv([["plain", "with,comma"]])).toContain('plain,"with,comma"');
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(toCsv([['say "hi"']])).toContain('"say ""hi"""');
  });

  it("quotes cells containing newlines", () => {
    expect(toCsv([["one\ntwo"]])).toContain('"one\ntwo"');
  });

  it("writes empty cells for null and undefined", () => {
    expect(toCsv([["a", null, undefined, 0]])).toContain("a,,,0");
  });

  it("emits a BOM and CRLF so Excel reads UTF-8 correctly", () => {
    const csv = toCsv([["Café"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("round-trips through the parser", () => {
    const rows = [
      ["Item", "Note"],
      ["Burger, large", 'says "hi"'],
      ["Fries", "line one\nline two"],
    ];
    const table = parseCsv(toCsv(rows));
    expect(table.headers).toEqual(rows[0]);
    expect(table.rows).toEqual(rows.slice(1));
  });
});
