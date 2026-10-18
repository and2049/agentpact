import type { JobSpec } from "../src/pact/types";

export const SELLER = "sb-seller@personal.example.com";

export function sampleJob(n = 3): JobSpec {
  return {
    id: "job-test",
    category: "product_descriptions",
    title: "Product descriptions for 3 SKUs",
    brief: "Write a short, factual product description per SKU.",
    skus: Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i + 1}`, facts: { name: `Widget ${i + 1}`, material: "steel", weight_g: 100 + i } })),
    rubric: { criteria: ["mentions material", "no invented specs"], threshold: 0.7, minWords: 20, maxWords: 80 },
    maxUnitPriceCents: 200,
    seller: SELLER,
  };
}

export const TEST_CARD = {
  number: "4012888888881881",
  expiry: "2030-12",
  name: "Buyer Agent",
  security_code: "123",
  billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
};
