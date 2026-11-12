"use client";

import { useMemo, useRef, useState } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";

import { Button } from "@/components/ui/button";
import type { PayoutRow, PledgeRow } from "@/services/dashboard/money";

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * AG Grid money dashboard (HACKATHON.md F5). Rows arrive from a Server
 * Component; this component only renders, filters and exports them.
 * Colours come from the site's CSS tokens, so light and dark themes follow
 * the app's own theme switch.
 */
const theme = themeQuartz.withParams({
  accentColor: "var(--color-brand)",
  backgroundColor: "var(--color-surface)",
  foregroundColor: "var(--color-ink)",
  borderColor: "color-mix(in srgb, var(--color-ink) 15%, transparent)",
  chromeBackgroundColor: "color-mix(in srgb, var(--color-ink) 5%, var(--color-surface))",
  oddRowBackgroundColor: "color-mix(in srgb, var(--color-ink) 2%, var(--color-surface))",
  fontFamily: "inherit",
  headerFontWeight: 700,
  wrapperBorderRadius: 8,
});

const STATUS_TONE: Record<string, string> = {
  FUNDED: "success",
  SUCCEEDED: "success",
  SUCCESS: "success",
  PLEDGED: "warning",
  PLANNED: "neutral",
  QUEUED: "warning",
  PROCESSING: "warning",
  PENDING: "warning",
  UNCLAIMED: "warning",
  MANUAL_REVIEW: "danger",
  FAILED: "danger",
  REFUNDED: "neutral",
};

const TONE_CLASS: Record<string, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  neutral: "bg-ink/10 text-ink",
};

function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value || value === "—") return <span className="text-muted">—</span>;
  const tone = STATUS_TONE[value.toUpperCase()] ?? "neutral";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${TONE_CLASS[tone]}`}>
      {value.toLowerCase().replace(/_/g, " ")}
    </span>
  );
}

function moneyFormatter(currency: string) {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
  return (p: ValueFormatterParams) => (typeof p.value === "number" ? fmt.format(p.value) : "");
}

const dateFormatter = (p: ValueFormatterParams) =>
  typeof p.value === "string" ? new Date(p.value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";

type Tab = "payouts" | "pledges";

export function MoneyGrid({
  pledges,
  payouts,
  currency,
  audience,
  fileName,
}: {
  pledges: PledgeRow[];
  payouts: PayoutRow[];
  currency: string;
  audience: "organizer" | "sponsor";
  fileName: string;
}) {
  const [tab, setTab] = useState<Tab>(payouts.length > 0 ? "payouts" : "pledges");
  const [filter, setFilter] = useState("");
  const pledgeGrid = useRef<AgGridReact<PledgeRow>>(null);
  const payoutGrid = useRef<AgGridReact<PayoutRow>>(null);
  const money = useMemo(() => moneyFormatter(currency), [currency]);
  const organizer = audience === "organizer";

  const pledgeCols = useMemo<ColDef<PledgeRow>[]>(
    () => [
      { field: "sponsor", headerName: "Sponsor", flex: 1.4, minWidth: 160 },
      ...(organizer ? [{ field: "email" as const, headerName: "Email", flex: 1.4, minWidth: 180 }] : []),
      { field: "amount", headerName: "Amount", type: "rightAligned", valueFormatter: money, filter: "agNumberColumnFilter", minWidth: 120 },
      { field: "status", headerName: "Status", cellRenderer: StatusPill, minWidth: 120 },
      { field: "fundedAt", headerName: "Funded", valueFormatter: dateFormatter, minWidth: 170 },
      ...(organizer
        ? [
            { field: "paypalOrderId" as const, headerName: "PayPal order", minWidth: 170 },
            { field: "paypalCaptureId" as const, headerName: "PayPal capture", minWidth: 170 },
          ]
        : []),
    ],
    [money, organizer]
  );

  const payoutCols = useMemo<ColDef<PayoutRow>[]>(
    () => [
      { field: "place", headerName: "#", width: 70, sort: "asc", filter: "agNumberColumnFilter" },
      { field: "team", headerName: "Team", flex: 1.2, minWidth: 150 },
      { field: "member", headerName: "Member", flex: 1, minWidth: 130 },
      { field: "paypal", headerName: "PayPal", flex: 1.3, minWidth: 170 },
      { field: "percent", headerName: "Split", width: 90, type: "rightAligned", valueFormatter: (p) => (typeof p.value === "number" ? `${p.value}%` : "") },
      { field: "amount", headerName: "Amount", type: "rightAligned", valueFormatter: money, filter: "agNumberColumnFilter", minWidth: 120 },
      { field: "status", headerName: "Status", cellRenderer: StatusPill, minWidth: 130 },
      { field: "paypalStatus", headerName: "PayPal status", cellRenderer: StatusPill, minWidth: 140 },
      { field: "paidAt", headerName: "Paid", valueFormatter: dateFormatter, minWidth: 170 },
      { field: "batch", headerName: "Batch", minWidth: 150 },
      ...(organizer
        ? [
            { field: "paypalItemId" as const, headerName: "PayPal item", minWidth: 160 },
            { field: "note" as const, headerName: "Note", flex: 1.5, minWidth: 200, tooltipField: "note" as const },
          ]
        : []),
    ],
    [money, organizer]
  );

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, filter: true, resizable: true }), []);

  const exportCsv = () => {
    const api = tab === "payouts" ? payoutGrid.current?.api : pledgeGrid.current?.api;
    api?.exportDataAsCsv({ fileName: `${fileName}-${tab}.csv` });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Dashboard tables" className="flex gap-1 rounded-control border border-ink/15 p-1">
          {(["payouts", "pledges"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-control px-3 py-1.5 text-sm font-semibold ${tab === t ? "bg-brand text-brand-ink" : "text-muted hover:text-ink"}`}
            >
              {t === "payouts" ? `Payouts (${payouts.length})` : `Pledges (${pledges.length})`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter rows…"
            aria-label="Filter rows"
            className="h-9 rounded-control border border-ink/20 bg-surface px-3 text-sm text-ink"
          />
          <Button type="button" variant="secondary" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
      </div>
      <div className="h-[460px] w-full">
        {tab === "payouts" ? (
          <AgGridReact<PayoutRow>
            ref={payoutGrid}
            theme={theme}
            rowData={payouts}
            columnDefs={payoutCols}
            defaultColDef={defaultColDef}
            quickFilterText={filter}
            getRowId={(p) => p.data.id}
            pagination
            paginationPageSize={20}
            paginationPageSizeSelector={[20, 50, 100]}
            tooltipShowDelay={300}
            overlayNoRowsTemplate="No payouts yet. They appear once winners are announced."
          />
        ) : (
          <AgGridReact<PledgeRow>
            ref={pledgeGrid}
            theme={theme}
            rowData={pledges}
            columnDefs={pledgeCols}
            defaultColDef={defaultColDef}
            quickFilterText={filter}
            getRowId={(p) => p.data.id}
            pagination
            paginationPageSize={20}
            paginationPageSizeSelector={[20, 50, 100]}
            overlayNoRowsTemplate="No sponsor pledges yet."
          />
        )}
      </div>
    </div>
  );
}
