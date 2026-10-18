/** Release a spike authorization: bun scripts/spike-void.ts <authorizationId> */
import { loadConfig } from "../src/config";
import { PayPalClient } from "../src/paypal/client";

const id = process.argv[2];
if (!id) {
  console.error("usage: bun scripts/spike-void.ts <authorizationId>");
  process.exit(2);
}
const c = loadConfig();
const pp = new PayPalClient({ base: c.paypalBase, clientId: c.clientId, clientSecret: c.clientSecret });
const before = await pp.getAuthorization(id);
console.log(`before: ${before.id} ${before.status} ${before.amount.value}`);
if (before.status === "CREATED") {
  const after = await pp.voidAuthorization({ requestId: crypto.randomUUID(), authorizationId: id });
  console.log(`after:  ${after.id} ${after.status}`);
}
