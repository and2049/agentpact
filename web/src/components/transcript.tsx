/**
 * The pact transcript: agent messages as chat rows, milestones as markers, and the noisy
 * technical log (webhooks, payout polls, retries) folded behind one toggle.
 */
import * as React from "react"
import { cn } from "cn"
import { AlertTriangleIcon, CheckIcon, CircleIcon, XIcon } from "lucide-react"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller"
import { EmptyState } from "@/components/primitives"
import type { Role } from "@/lib/api"

export type Level = "info" | "ok" | "warn" | "bad"
export type Entry =
  | { kind: "message"; id: string; role: Role; text: string }
  | { kind: "event"; id: string; text: string; level: Level; technical: boolean; count: number }

const ROLE_LABEL: Record<Role, string> = { buyer: "Buyer agent", seller: "Seller agent", verifier: "Verifier", platform: "Platform" }
const ROLE_BG: Record<Role, string> = { buyer: "bg-role-buyer", seller: "bg-role-seller", verifier: "bg-role-verifier", platform: "bg-role-platform" }

function LevelIcon({ level }: { level: Level }) {
  if (level === "ok") return <CheckIcon className="text-success" />
  if (level === "bad") return <XIcon className="text-destructive" />
  if (level === "warn") return <AlertTriangleIcon className="text-warning" />
  return <CircleIcon className="size-2! text-muted-foreground/60" />
}

export function Transcript({ entries, className }: { entries: Entry[]; className?: string }) {
  const [showTech, setShowTech] = React.useState(false)
  const tech = entries.filter((e) => e.kind === "event" && e.technical).length
  const shown = showTech ? entries : entries.filter((e) => e.kind !== "event" || !e.technical)

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Buyer agent · seller agent · verifier · platform</span>
        {tech > 0 && (
          <Button variant="ghost" size="xs" aria-pressed={showTech} onClick={() => setShowTech((v) => !v)}>
            {showTech ? "Hide" : "Show"} {tech} technical event{tech === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      {shown.length === 0 ? (
        <EmptyState title="Waiting for the first message" description="The transcript fills in as the agents talk." />
      ) : (
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="min-h-80 flex-1">
            <MessageScrollerViewport className="pr-2">
              <MessageScrollerContent className="gap-3 py-1">
                {shown.map((e) => (
                  <MessageScrollerItem key={e.id} messageId={e.id} className="[contain-intrinsic-size:auto_2.5rem]">
                    {e.kind === "message" ? (
                      <Message>
                        <MessageAvatar className={cn("size-7 min-w-7 self-start text-[11px] font-semibold text-white", ROLE_BG[e.role])}>{e.role[0]!.toUpperCase()}</MessageAvatar>
                        <MessageContent className="gap-1">
                          <MessageHeader className="px-0">{ROLE_LABEL[e.role]}</MessageHeader>
                          <Bubble variant="muted">
                            <BubbleContent className="whitespace-pre-wrap">{e.text}</BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    ) : (
                      <Marker className={cn("pl-9 text-xs", e.technical && "font-mono text-[11px]")}>
                        <MarkerIcon>
                          <LevelIcon level={e.level} />
                        </MarkerIcon>
                        <MarkerContent className={cn(e.level === "bad" && "text-destructive", e.level === "warn" && "text-warning", e.level === "ok" && "text-foreground")}>
                          {e.text}
                          {e.count > 1 && <span className="text-muted-foreground"> ×{e.count}</span>}
                        </MarkerContent>
                      </Marker>
                    )}
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
    </div>
  )
}
