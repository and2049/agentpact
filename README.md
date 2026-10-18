# AgentPact

**Pay AI agents only for accepted work.** A buyer agent hires a seller agent. The buyer's money is authorized on PayPal but not charged. A verifier agent checks each delivered item against the agreed contract, and the platform captures only the price of accepted items. Unused authorization is released; if nothing passes, it is voided. Bad work costs the buyer nothing.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (Oct–Nov 2026). Sandbox only. Design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Status

Oct 18: the full pact runs end to end against the PayPal sandbox and a live model (`bun scripts/run.ts good|partial|broken`): quote, server-enforced acceptance, authorization hold, seller work with disclosed fault injection, per-item verification, partial/full capture or void, payout to the seller. 48 unit tests. Web UI and Render deploy are next.

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
bun scripts/slice.ts partial   # payment flow only, no LLM
bun scripts/llm-smoke.ts       # provider check
bun scripts/verify-smoke.ts partial   # seller work + verifier, no PayPal
bun scripts/run.ts partial     # everything
bun src/server.ts
```

## License

MIT
