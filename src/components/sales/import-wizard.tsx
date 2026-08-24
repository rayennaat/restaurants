"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileSpreadsheet, Info, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FormError } from "@/components/ui/form";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { parseCsv, toCsv, CsvParseError } from "@/lib/csv";
import { formatMoney } from "@/lib/money";
import {
  buildErrorReport,
  buildImportPlan,
  buildSampleCsvRows,
  suggestMapping,
  DATE_FORMAT_LABELS,
  DATE_FORMATS,
  FIELD_HINTS,
  FIELD_LABELS,
  IMPORT_FIELDS,
  ISSUE_LABELS,
  REQUIRED_FIELDS,
  missingRequiredFields,
  type ColumnMapping,
  type DateFormat,
  type ImportField,
  type ImportPlan,
  type SourceRow,
} from "@/lib/sales-import";
import { commitSalesImport } from "@/server/actions/sales-import";
import type { LocationOption } from "@/server/queries/locations";

/**
 * The import wizard: upload → map → check → import.
 *
 * The plan shown here is computed **in the browser**, by the same pure
 * `buildImportPlan` the server runs. That is what makes the mapping screen feel
 * immediate — changing a dropdown re-validates 20,000 rows without a round trip.
 *
 * It is emphatically *not* what gets imported. On confirm the file, the mapping
 * and the options are sent to the server, which re-parses and re-plans against
 * its own catalog and writes the result. So this component is a fast, honest
 * preview of a decision the server makes independently — and a tampered preview
 * changes nothing about what lands in the database.
 *
 * The four steps are deliberately linear. A restaurant owner importing a year of
 * tickets should never be asked a question they cannot answer from looking at
 * their own spreadsheet.
 */

type MenuOption = { id: string; name: string; sellingPriceMillis: number };
type Step = "upload" | "map" | "review";

const MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_LIMIT = 50;

/** Hands a generated file to the browser. Shared by the sample and the error report. */
function download(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function ImportWizard({
  locations,
  menuItems,
  currency,
  defaultLocationId,
}: {
  locations: LocationOption[];
  menuItems: MenuOption[];
  currency: string;
  defaultLocationId?: string;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [locationId, setLocationId] = useState(defaultLocationId ?? locations[0]?.id ?? "");
  const [dateFormat, setDateFormat] = useState<DateFormat>("auto");
  const [aliases, setAliases] = useState<Record<string, string>>({});

  /** Parsed once per file; every mapping change re-plans from this. */
  const parsed = useMemo(() => {
    if (!content) return null;
    try {
      return { table: parseCsv(content), error: null as string | null };
    } catch (parseError) {
      const message =
        parseError instanceof CsvParseError
          ? `Line ${parseError.line}: ${parseError.message}`
          : "That file could not be read as CSV.";
      return { table: null, error: message };
    }
  }, [content]);

  const table = parsed?.table ?? null;

  const rows: SourceRow[] = useMemo(() => {
    if (!table) return [];
    return table.rows.map((cells, index) => {
      const record: Record<string, string> = {};
      table.headers.forEach((header, column) => {
        record[header] = cells[column] ?? "";
      });
      const line = index + 2;
      return { line, cells: record, ragged: table.ragged.some(entry => entry.line === line) };
    });
  }, [table]);

  const missing = missingRequiredFields(mapping);

  /** The same plan the server will build, minus what the database already holds. */
  const plan: ImportPlan | null = useMemo(() => {
    if (!table || missing.length || !locationId) return null;
    return buildImportPlan(rows, {
      mapping,
      catalog: menuItems,
      locations,
      defaultLocationId: locationId,
      currency,
      dateFormat,
      aliases,
    });
  }, [table, rows, mapping, missing.length, locationId, locations, menuItems, currency, dateFormat, aliases]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);

    if (file.size > MAX_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 8 MB — try splitting it by month.`);
      return;
    }

    const text = await file.text();
    setFilename(file.name);
    setContent(text);
    setAliases({});

    try {
      const detected = parseCsv(text);
      if (!detected.headers.length) {
        setError("That file has no columns to read.");
        return;
      }
      if (!detected.rows.length) {
        setError("That file has a header row but no data underneath it.");
        return;
      }
      setMapping(suggestMapping(detected.headers));
      setStep("map");
    } catch (parseError) {
      setError(
        parseError instanceof CsvParseError
          ? `Line ${parseError.line}: ${parseError.message}`
          : "That file could not be read as CSV.",
      );
    }
  };

  const downloadErrors = () => {
    if (!plan || !table) return;
    const csv = toCsv(buildErrorReport(plan, table.headers));
    download(csv, `${filename.replace(/\.csv$/i, "")}-problems.csv`);
  };

  /**
   * The example file.
   *
   * Built from this workspace's own menu and location, so it imports cleanly
   * rather than failing on dish names the restaurant does not sell. It is only
   * ever downloaded — never fed into the importer — so the owner opens it,
   * sees the shape, and decides what to do next.
   */
  const downloadSample = () => {
    if (!menuItems.length) return;
    const rows = buildSampleCsvRows(
      menuItems,
      locations.find(option => option.id === locationId)?.name ?? locations[0]?.name ?? "Main",
      currency,
      new Date(),
    );
    download(toCsv(rows), "sample-sales-import.csv");
  };

  const confirm = () => {
    if (!plan) return;
    setError(null);

    startTransition(async () => {
      const result = await commitSalesImport({
        filename,
        content,
        mapping,
        locationId,
        dateFormat,
        currency,
        aliases,
        // What the user is confirming. The server re-validates and refuses if
        // its own count differs, so a stale preview cannot be committed.
        expectedImportedRows: plan.stats.importedRows,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success(
        `Imported ${result.data.saleCount.toLocaleString()} sale${result.data.saleCount === 1 ? "" : "s"} from ${filename}.`,
      );
      router.push(`/dashboard/sales/imports/${result.data.importId}`);
      router.refresh();
    });
  };

  const reset = () => {
    setStep("upload");
    setContent("");
    setFilename("");
    setMapping({});
    setAliases({});
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="space-y-6">
      <Steps current={step} />

      {/* ------------------------------------------------------------ upload */}
      {step === "upload" && (
        <Card>
          <CardContent className="pt-5">
            <label
              htmlFor="sales-import-file"
              className="grid cursor-pointer place-items-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition hover:border-green-700 hover:bg-green-50/40"
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                event.preventDefault();
                void onFile(event.dataTransfer.files[0]);
              }}
            >
              <span className="grid size-12 place-items-center rounded-lg bg-green-50 text-green-800">
                <Upload size={26} />
              </span>
              <b className="mt-4 block text-lg">Choose your sales file</b>
              <span className="mt-2 block max-w-md text-sm text-[var(--muted)]">
                Export sales from your till as CSV and drop it here. Any format works — you will match up the columns on
                the next screen. Nothing is imported until you have checked it.
              </span>
              <span className="mt-5 inline-flex h-10 items-center rounded-lg bg-[var(--primary)] px-4 font-semibold text-white">
                Select CSV file
              </span>
              <input
                ref={fileInput}
                id="sales-import-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                onChange={event => void onFile(event.target.files?.[0])}
              />
            </label>
            <FormError message={error} className="mt-4" />

            {/* The example, offered beside the upload box rather than inside
                it — it is a thing to look at first, not a file to submit. */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-neutral-50/70 px-4 py-3">
              <p className="text-sm text-[var(--muted)]">
                <b className="text-neutral-900">Not sure what the file should look like?</b> Download an example built
                from your own menu. It is a template to compare against — downloading it does not import anything.
              </p>
              <Button variant="secondary" size="sm" onClick={downloadSample} disabled={menuItems.length === 0}>
                <FileSpreadsheet size={15} /> Example CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------------- map */}
      {step === "map" && table && (
        <>
          <Card>
            <CardHeader>
              <h2 className="text-lg font-black">Match your columns</h2>
              <p className="text-sm text-[var(--muted)]">
                We have guessed these from your headings. Change anything that looks wrong — only the first three are
                required.
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {IMPORT_FIELDS.map(field => (
                  <Field
                    key={field}
                    label={FIELD_LABELS[field]}
                    required={(REQUIRED_FIELDS as readonly ImportField[]).includes(field)}
                    hint={FIELD_HINTS[field]}
                  >
                    <Select
                      value={mapping[field] ?? ""}
                      onChange={event =>
                        setMapping(current => ({ ...current, [field]: event.target.value || null }))
                      }
                    >
                      <option value="">
                        {(REQUIRED_FIELDS as readonly ImportField[]).includes(field) ? "Choose a column…" : "Not in my file"}
                      </option>
                      {table.headers.map(header => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>

              <div className="grid gap-4 border-t pt-5 sm:grid-cols-3">
                <Field label="Import into" required hint="Used for rows that do not name a location.">
                  <Select value={locationId} onChange={event => setLocationId(event.target.value)}>
                    {locations.map(option => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Date format" hint="Only matters for dates like 03/04/2025.">
                  <Select value={dateFormat} onChange={event => setDateFormat(event.target.value as DateFormat)}>
                    {DATE_FORMATS.map(format => (
                      <option key={format} value={format}>
                        {DATE_FORMAT_LABELS[format]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Amounts are in" hint="Your workspace currency.">
                  <Select value={currency} disabled>
                    <option value={currency}>{currency}</option>
                  </Select>
                </Field>
              </div>

              {missing.length > 0 && (
                <p className="rounded-lg bg-amber-50 p-3 text-sm font-semibold text-amber-800">
                  Still needed: {missing.map(field => FIELD_LABELS[field]).join(", ")}.
                </p>
              )}
            </CardContent>
          </Card>

          <SampleTable table={table} mapping={mapping} />

          <div className="flex flex-wrap justify-between gap-3">
            <Button variant="secondary" onClick={reset}>
              <ArrowLeft size={16} /> Choose a different file
            </Button>
            <Button disabled={missing.length > 0 || !plan} onClick={() => setStep("review")}>
              Check the data <ArrowRight size={16} />
            </Button>
          </div>
        </>
      )}

      {/* ------------------------------------------------------------ review */}
      {step === "review" && plan && table && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Rows in file" value={plan.stats.totalRows.toLocaleString()} />
            <Stat label="Will be imported" value={plan.stats.importedRows.toLocaleString()} tone="success" />
            <Stat
              label="Will be skipped"
              value={plan.stats.skippedRows.toLocaleString()}
              tone={plan.stats.skippedRows > 0 ? "warning" : "neutral"}
              hint={plan.stats.duplicateRows > 0 ? `${plan.stats.duplicateRows} already imported` : undefined}
            />
            <Stat label="Total value" value={formatMoney(plan.stats.totalMillis, currency)} />
          </div>

          {plan.period && (
            <p className="text-sm text-[var(--muted)]">
              <Info size={14} className="mr-1 inline" />
              Covers {plan.period.from.toLocaleDateString()} to {plan.period.to.toLocaleDateString()}, creating{" "}
              {plan.stats.saleCount.toLocaleString()} sale{plan.stats.saleCount === 1 ? "" : "s"} from{" "}
              {plan.stats.importedRows.toLocaleString()} row{plan.stats.importedRows === 1 ? "" : "s"}.
            </p>
          )}

          {plan.unknownMenuItems.length > 0 && (
            <UnknownItems
              unknown={plan.unknownMenuItems}
              menuItems={menuItems}
              aliases={aliases}
              onChange={(value, menuItemId) =>
                setAliases(current => {
                  const next = { ...current };
                  if (menuItemId) next[value] = menuItemId;
                  else delete next[value];
                  return next;
                })
              }
            />
          )}

          {plan.unknownLocations.length > 0 && (
            <Card className="border-amber-200">
              <CardHeader>
                <h2 className="flex items-center gap-2 text-lg font-black">
                  <AlertTriangle size={18} className="text-amber-600" /> Locations not recognised
                </h2>
                <p className="text-sm text-[var(--muted)]">
                  These appear in your location column but are not locations in this workspace. Rows naming them are
                  skipped. Add the location in Settings, or remove that column from the mapping to send everything to{" "}
                  {locations.find(option => option.id === locationId)?.name}.
                </p>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {plan.unknownLocations.map(entry => (
                  <Badge key={entry.value} tone="warning">
                    {entry.value} · {entry.rowCount} row{entry.rowCount === 1 ? "" : "s"}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          <IssueSummary plan={plan} onDownload={downloadErrors} />

          <PreviewTable plan={plan} table={table} currency={currency} />

          <FormError message={error} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" onClick={() => setStep("map")}>
              <ArrowLeft size={16} /> Back to mapping
            </Button>
            <div className="flex flex-wrap items-center gap-3">
              {plan.stats.skippedRows > 0 && (
                <Button variant="secondary" onClick={downloadErrors}>
                  <Download size={16} /> Download skipped rows
                </Button>
              )}
              <Button onClick={confirm} disabled={pending || plan.stats.importedRows === 0}>
                {pending ? "Importing…" : (
                  <>
                    <CheckCircle2 size={16} /> Import {plan.stats.importedRows.toLocaleString()} row
                    {plan.stats.importedRows === 1 ? "" : "s"}
                  </>
                )}
              </Button>
            </div>
          </div>

          {plan.stats.importedRows === 0 && (
            <p className="text-sm text-[var(--muted)]">
              Nothing can be imported yet. Fix the problems above — or go back and check the column mapping.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Progress rail. Three named steps, so the user always knows what is left. */
function Steps({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "upload", label: "Upload file" },
    { key: "map", label: "Match columns" },
    { key: "review", label: "Check and import" },
  ];
  const index = steps.findIndex(step => step.key === current);

  return (
    <ol className="flex flex-wrap items-center gap-3 text-sm">
      {steps.map((step, position) => (
        <li key={step.key} className="flex items-center gap-3">
          <span
            className={
              position <= index
                ? "flex items-center gap-2 font-bold text-green-900"
                : "flex items-center gap-2 text-[var(--muted)]"
            }
          >
            <span
              className={`grid size-6 place-items-center rounded-full text-xs font-black ${
                position < index
                  ? "bg-green-700 text-white"
                  : position === index
                    ? "bg-green-100 text-green-900 ring-2 ring-green-700"
                    : "bg-neutral-100 text-neutral-500"
              }`}
            >
              {position < index ? "✓" : position + 1}
            </span>
            {step.label}
          </span>
          {position < steps.length - 1 && <span className="h-px w-6 bg-neutral-300" />}
        </li>
      ))}
    </ol>
  );
}

function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint?: string; tone?: "neutral" | "success" | "warning" }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">{label}</p>
        <p
          className={`mt-1 text-2xl font-black tabular-nums ${
            tone === "success" ? "text-green-800" : tone === "warning" ? "text-amber-700" : ""
          }`}
        >
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** The file as read, so the user can confirm the columns split correctly. */
function SampleTable({ table, mapping }: { table: NonNullable<ReturnType<typeof parseCsv>>; mapping: ColumnMapping }) {
  const mappedBy = new Map<string, ImportField>();
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    if (column) mappedBy.set(column, field);
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <h2 className="text-lg font-black">Your file, as we read it</h2>
        <p className="text-sm text-[var(--muted)]">
          {table.totalRows.toLocaleString()} row{table.totalRows === 1 ? "" : "s"} · {table.headers.length} columns ·
          separated by {table.delimiter === "\t" ? "tabs" : `"${table.delimiter}"`}
          {table.ragged.length > 0 && ` · ${table.ragged.length} row(s) have a different number of columns`}
        </p>
      </CardHeader>
      <Table className="min-w-[720px]">
        <THead>
          <TR className="hover:bg-transparent">
            {table.headers.map(header => (
              <TH key={header}>
                <span className="block">{header}</span>
                {mappedBy.has(header) && (
                  <span className="mt-1 block text-[10px] font-bold uppercase tracking-wider text-green-700">
                    {FIELD_LABELS[mappedBy.get(header)!]}
                  </span>
                )}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {table.rows.slice(0, 5).map((cells, index) => (
            <TR key={index}>
              {table.headers.map((header, column) => (
                <TD key={header} className="max-w-56 truncate text-sm">
                  {cells[column]}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

/**
 * Unmatched dish names, each with a picker.
 *
 * The product rule made visible: an unknown name is never created as a menu
 * item, it is *pointed at* one that already exists. Anything left unmapped stays
 * skipped, which is stated rather than implied.
 */
function UnknownItems({
  unknown,
  menuItems,
  aliases,
  onChange,
}: {
  unknown: ImportPlan["unknownMenuItems"];
  menuItems: MenuOption[];
  aliases: Record<string, string>;
  onChange: (value: string, menuItemId: string) => void;
}) {
  return (
    <Card className="border-amber-200">
      <CardHeader>
        <h2 className="flex items-center gap-2 text-lg font-black">
          <AlertTriangle size={18} className="text-amber-600" /> Menu item not found
        </h2>
        <p className="text-sm text-[var(--muted)]">
          These names are in your file but not on your menu. Point each one at the dish it corresponds to — we will not
          create new menu items from a file. Anything left unmatched is skipped.
        </p>
      </CardHeader>
      <Table className="min-w-[560px]">
        <THead>
          <TR className="hover:bg-transparent">
            <TH>Name in your file</TH>
            <TH className="text-right">Rows</TH>
            <TH>Use this menu item</TH>
          </TR>
        </THead>
        <TBody>
          {unknown.map(entry => (
            <TR key={entry.value}>
              <TD>
                <b className="text-sm">{entry.value}</b>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">
                  Line{entry.lines.length === 1 ? "" : "s"} {entry.lines.slice(0, 5).join(", ")}
                  {entry.rowCount > 5 ? "…" : ""}
                </span>
              </TD>
              <TD className="text-right tabular-nums">{entry.rowCount}</TD>
              <TD>
                <Select
                  aria-label={`Menu item for ${entry.value}`}
                  value={aliases[entry.value] ?? ""}
                  onChange={event => onChange(entry.value, event.target.value)}
                >
                  <option value="">Skip these rows</option>
                  {menuItems.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

/** Grouped problem counts — "42 rows: date could not be read" beats 42 messages. */
function IssueSummary({ plan, onDownload }: { plan: ImportPlan; onDownload: () => void }) {
  const counts = new Map<string, { code: string; count: number; severity: string }>();
  for (const row of plan.rows) {
    for (const entry of row.issues) {
      const existing = counts.get(entry.code);
      if (existing) existing.count += 1;
      else counts.set(entry.code, { code: entry.code, count: 1, severity: entry.severity });
    }
  }
  if (!counts.size) return null;

  const list = [...counts.values()].sort((a, b) => b.count - a.count);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">What needs attention</h2>
            <p className="text-sm text-[var(--muted)]">
              Errors skip the row. Warnings still import, with the note kept on the record.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onDownload}>
            <Download size={15} /> Download details
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {list.map(entry => (
          <div key={entry.code} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <Badge tone={entry.severity === "error" ? "danger" : "warning"}>
                {entry.severity === "error" ? "Skipped" : "Imported"}
              </Badge>
              {ISSUE_LABELS[entry.code as keyof typeof ISSUE_LABELS] ?? entry.code}
            </span>
            <b className="tabular-nums">
              {entry.count} row{entry.count === 1 ? "" : "s"}
            </b>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Row-by-row verdict, so a skipped row can be traced to its line and reason. */
function PreviewTable({
  plan,
  table,
  currency,
}: {
  plan: ImportPlan;
  table: NonNullable<ReturnType<typeof parseCsv>>;
  currency: string;
}) {
  const [filter, setFilter] = useState<"all" | "import" | "skip">("all");

  const rows = plan.rows.filter(row => (filter === "all" ? true : row.status === filter));
  const shown = rows.slice(0, PREVIEW_LIMIT);

  // Line -> planned line, so the table can show the price that will be stored.
  const plannedByLine = new Map(plan.sales.flatMap(sale => sale.lines.map(line => [line.line, line])));

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">Row by row</h2>
            <p className="text-sm text-[var(--muted)]">
              Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()} row
              {rows.length === 1 ? "" : "s"}.
            </p>
          </div>
          <div className="flex gap-2">
            {(["all", "import", "skip"] as const).map(value => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? "primary" : "secondary"}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "All" : value === "import" ? "Importing" : "Skipped"}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <Table className="min-w-[820px]">
        <THead>
          <TR className="hover:bg-transparent">
            <TH className="w-16">Line</TH>
            <TH className="w-28">Status</TH>
            <TH>Menu item</TH>
            <TH className="text-right">Qty</TH>
            <TH className="text-right">Unit price</TH>
            <TH>Notes</TH>
          </TR>
        </THead>
        <TBody>
          {shown.map(row => {
            const planned = plannedByLine.get(row.line);
            return (
              <TR key={row.line}>
                <TD className="tabular-nums text-[var(--muted)]">{row.line}</TD>
                <TD>
                  <Badge tone={row.status === "import" ? "success" : "danger"}>
                    {row.status === "import" ? "Import" : "Skip"}
                  </Badge>
                </TD>
                <TD className="max-w-56 truncate text-sm">{row.resolvedMenuItemName ?? "—"}</TD>
                <TD className="text-right tabular-nums">{planned ? planned.quantity.toLocaleString() : "—"}</TD>
                <TD className="text-right tabular-nums">
                  {planned ? formatMoney(planned.unitPriceMillis, currency) : "—"}
                </TD>
                <TD className="text-sm text-[var(--muted)]">
                  {row.issues.length ? row.issues.map(issue => issue.message).join(" · ") : "—"}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {table.truncated && (
        <CardContent className="border-t pt-3 text-xs text-[var(--muted)]">
          <FileSpreadsheet size={13} className="mr-1 inline" />
          Only the first {plan.stats.totalRows.toLocaleString()} rows of this file are read in one import. Split larger
          files by month.
        </CardContent>
      )}
    </Card>
  );
}
