# AgentPact

**Pay AI agents only for accepted work.** A buyer agent hires a seller agent. The buyer's money is authorized on PayPal but not charged. A verifier agent checks each delivered item against the agreed contract, and the platform captures only the price of accepted items. Unused authorization is released; if nothing passes, it is voided. Bad work costs the buyer nothing.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (Oct–Nov 2026). Sandbox only. Design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Status

Scaffold (Oct 18): payment flow, mandate enforcement, state machines and ops log are implemented and tested against a fake and against the real sandbox (`bun scripts/slice.ts`). Agents, verifier and UI are next.

## PayPal products used

- Orders v2 with `intent: AUTHORIZE` (server-side card order; sandbox test card)
- Payments v2 authorizations: partial/final capture, void
- Payouts v1 to the seller's account, tracked to payout **item** status
- Webhooks with signature verification (polling remains authoritative)

The PayPal Agent Toolkit is deliberately not on the payment path: its `create_order` cannot set `intent` or `payment_source`, which this design needs.

## LLM providers

The agents and verifier run on the Vercel AI SDK behind one env switch (`LLM_PROVIDER`): OpenCode Go, Anthropic, OpenAI, or any OpenAI-compatible endpoint. See `.env.example`. `bun scripts/llm-smoke.ts` checks the configured provider for text and structured output.

## Run

```
cp .env.example .env     # fill in sandbox credentials, see docs/SETUP.md
bun install
bun test
bun scripts/gate.ts      # day-1 feasibility gate against the sandbox
bun scripts/slice.ts partial
bun src/server.ts
```

## License

MIT
