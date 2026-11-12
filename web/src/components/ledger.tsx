/** Item ledger: one AG Grid row per SKU with verdict, score, reason (evidence on hover) and charge. */
import * as React from "react"
import { AgGridReact } from "ag-grid-react"
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community"

import { Badge } from "@/components/ui/badge"
import type { LedgerRow } from "@/components/ledger-rows"

ModuleRegistry.registerModules([AllCommunityModule])

// Literal colors mirror the tokens in index.css (AG Grid derives shades from these, so no var()).
const theme = themeQuartz.withParams({
  backgroundColor: "#fdfdfb",
  foregroundColor: "#2c322c",
  headerBackgroundColor: "#f1f0ea",
  headerTextColor: "#5f655c",
  borderColor: "#dedcd4",
  rowHoverColor: "#f5f4ef",
  accentColor: "#3f5a40",
  fontFamily: "'Geist Variable', system-ui, sans-serif",
  fontSize: 13,
  headerFontSize: 11,
  spacing: 6,
  wrapperBorderRadius: 8,
})

function VerdictCell(p: ICellRendererParams<LedgerRow, LedgerRow["verdict"]>) {
  if (!p.value || p.node.rowPinned) return null
  return <Badge variant={p.value === "accepted" ? "success" : p.value === "rejected" ? "destructive" : "secondary"}>{p.value}</Badge>
}

const money = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`)

export function Ledger({ rows, unitCents, className }: { rows: LedgerRow[]; unitCents: number; className?: string }) {
  const columnDefs = React.useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "sku", headerName: "SKU", width: 104, minWidth: 96, pinned: "left", cellClass: "font-mono" },
      // The pinned summary row spans product through reason so its text is never clipped.
      { field: "name", headerName: "Product", minWidth: 150, flex: 1, colSpan: (p) => (p.node?.rowPinned ? 4 : 1) },
      { field: "verdict", headerName: "Verdict", width: 118, minWidth: 110, cellRenderer: VerdictCell, filter: true },
      { field: "score", headerName: "Score", width: 84, minWidth: 80, type: "numericColumn", valueFormatter: (c) => (c.value == null ? "" : c.value.toFixed(2)) },
      { field: "reason", headerName: "Reason", minWidth: 220, flex: 3, tooltipField: "evidence", wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.45", paddingTop: "8px", paddingBottom: "8px" } },
      { field: "amount", headerName: "Charge", width: 96, minWidth: 90, type: "numericColumn", valueFormatter: (c) => money(c.value), cellClass: "font-mono" },
    ],
    [],
  )
  const acc = rows.filter((r) => r.verdict === "accepted").length
  const rej = rows.filter((r) => r.verdict === "rejected").length
  const pinnedBottomRowData = React.useMemo<LedgerRow[]>(
    () => [{ sku: "Σ", name: `${acc} accepted · ${rej} rejected · ${rows.length - acc - rej} pending`, verdict: "pending", score: null, reason: "", evidence: "", amount: acc * unitCents }],
    [acc, rej, rows.length, unitCents],
  )
  return (
    <div className={className}>
      <AgGridReact<LedgerRow>
        theme={theme}
        domLayout="autoHeight"
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true }}
        getRowId={(p) => p.data.sku}
        pinnedBottomRowData={pinnedBottomRowData}
        animateRows
        tooltipShowDelay={300}
        suppressCellFocus
        getRowClass={(p) => (p.node.rowPinned ? "font-medium" : undefined)}
      />
    </div>
  )
}
