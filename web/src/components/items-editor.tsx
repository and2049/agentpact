/**
 * Item entry for a job: a table (SKU, product name, other facts), CSV paste, or raw JSON.
 * Output is always the API shape `{ sku, facts }[]` with `facts.name` set from the Name column.
 */
import * as React from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/primitives"
import type { Facts, JobItem } from "@/lib/api"

export interface Row { sku: string; name: string; facts: string }

const coerce = (v: string): string | number => (v.trim() !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v.trim())

/** "material: carbon fiber; weight_g: 210" → { material: "carbon fiber", weight_g: 210 } */
export function parseFacts(text: string): Facts {
  const out: Facts = {}
  for (const part of text.split(/[;\n]|,(?=\s*[\w-]+\s*[:=])/)) {
    const m = part.match(/^\s*([\w .-]+?)\s*[:=]\s*(.+?)\s*$/)
    if (m) out[m[1]!.trim().replace(/\s+/g, "_")] = coerce(m[2]!)
  }
  return out
}
export const factsText = (facts: Facts): string =>
  Object.entries(facts)
    .filter(([k]) => k !== "name")
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ")

export const rowsToItems = (rows: Row[]): JobItem[] =>
  rows
    .filter((r) => r.sku.trim())
    .map((r) => ({ sku: r.sku.trim(), facts: { name: r.name.trim(), ...parseFacts(r.facts) } }))
export const itemsToRows = (items: JobItem[]): Row[] => items.map((i) => ({ sku: i.sku, name: String(i.facts.name ?? ""), facts: factsText(i.facts) }))

/** Minimal CSV: header row, quoted fields allowed. Needs `sku`; `name` optional; other columns are facts. */
export function parseCsv(text: string): JobItem[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) throw new Error("Paste a header row and at least one item row.")
  const split = (line: string): string[] => {
    const cells: string[] = []
    let cur = ""
    let q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false
        else cur += ch
      } else if (ch === '"') q = true
      else if (ch === "," || ch === "\t") { cells.push(cur); cur = "" }
      else cur += ch
    }
    cells.push(cur)
    return cells.map((c) => c.trim())
  }
  const header = split(lines[0]!).map((h) => h.toLowerCase().replace(/\s+/g, "_"))
  const skuCol = header.indexOf("sku")
  if (skuCol < 0) throw new Error('The header row needs a "sku" column.')
  return lines.slice(1).map((line) => {
    const cells = split(line)
    const facts: Facts = {}
    header.forEach((h, i) => {
      if (i === skuCol || !h || !cells[i]) return
      facts[h] = coerce(cells[i]!)
    })
    return { sku: cells[skuCol] ?? "", facts }
  }).filter((i) => i.sku)
}

export const SAMPLE_ITEMS: JobItem[] = [
  { sku: "TRK-001", facts: { name: "Ridgeline Trekking Pole", material: "carbon fiber", weight_g: 210, color: "slate" } },
  { sku: "TRK-002", facts: { name: "Summit 40 Backpack", material: "ripstop nylon", capacity_l: 40, color: "forest green" } },
  { sku: "TRK-003", facts: { name: "Ember Camp Stove", material: "titanium", weight_g: 85, fuel: "isobutane" } },
]

export function ItemsEditor({ rows, onChange, max = 20 }: { rows: Row[]; onChange: (rows: Row[]) => void; max?: number }) {
  const [tab, setTab] = React.useState("table")
  const [csv, setCsv] = React.useState("")
  const [json, setJson] = React.useState(() => JSON.stringify(rowsToItems(rows), null, 2))
  const [error, setError] = React.useState<unknown>(null)

  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const apply = (items: JobItem[]) => {
    if (!items.length) throw new Error("No items found.")
    if (items.length > max) throw new Error(`At most ${max} items per job.`)
    onChange(itemsToRows(items))
    setTab("table")
  }

  return (
    <Tabs value={tab} onValueChange={(v) => { setTab(String(v)); setError(null); if (v === "json") setJson(JSON.stringify(rowsToItems(rows), null, 2)) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="table">Table</TabsTrigger>
          <TabsTrigger value="csv">Paste CSV</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <span className="text-xs text-muted-foreground">
          {rows.filter((r) => r.sku.trim()).length} of {max} items
        </span>
      </div>

      <TabsContent value="table" className="flex flex-col gap-3">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">SKU</TableHead>
                <TableHead className="w-56">Product name</TableHead>
                <TableHead>Other facts (key: value; …)</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="p-1.5">
                    <Input aria-label="SKU" className="font-mono" value={r.sku} placeholder="SKU-001" onChange={(e) => update(i, { sku: e.target.value })} />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Input aria-label="Product name" value={r.name} placeholder="Product name" onChange={(e) => update(i, { name: e.target.value })} />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Input aria-label="Other facts" value={r.facts} placeholder="material: titanium; weight_g: 85" onChange={(e) => update(i, { facts: e.target.value })} />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove row" disabled={rows.length === 1} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={rows.length >= max} onClick={() => onChange([...rows, { sku: "", name: "", facts: "" }])}>
            <PlusIcon data-icon="inline-start" />
            Add item
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(itemsToRows(SAMPLE_ITEMS))}>
            Load sample items
          </Button>
        </div>
        <FieldDescription>Every fact you list must appear in the description; the verifier rejects items that drop or alter a fact.</FieldDescription>
      </TabsContent>

      <TabsContent value="csv" className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="csv">CSV or tab-separated, with a header row</FieldLabel>
          <Textarea id="csv" rows={8} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"sku,name,material,weight_g\nTRK-001,Ridgeline Trekking Pole,carbon fiber,210"} />
          <FieldDescription>Needs a sku column. Every other column becomes a fact. Replaces the table.</FieldDescription>
        </Field>
        <Notice error={error} />
        <div>
          <Button type="button" size="sm" onClick={() => { try { apply(parseCsv(csv)); setError(null) } catch (e) { setError(e) } }}>
            Use these items
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="json" className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="json">Items as JSON</FieldLabel>
          <Textarea id="json" rows={12} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
          <FieldDescription>An array of {"{ sku, facts }"}; facts is an object of strings and numbers. Replaces the table.</FieldDescription>
        </Field>
        <Notice error={error} />
        <div>
          <Button type="button" size="sm" onClick={() => { try { const v = JSON.parse(json) as JobItem[]; if (!Array.isArray(v)) throw new Error("Expected an array."); apply(v); setError(null) } catch (e) { setError(e) } }}>
            Use these items
          </Button>
        </div>
      </TabsContent>
    </Tabs>
  )
}
