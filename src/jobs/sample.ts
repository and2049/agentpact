import type { JobSpec } from "../pact/types";

/** The demo job: 20 outdoor-gear SKUs with supplied facts the description must carry. */
export function sampleJob(seller: string, overrides: Partial<JobSpec> = {}): JobSpec {
  const skus: JobSpec["skus"] = [
    { sku: "TRK-001", facts: { name: "Ridgeline Trekking Pole", material: "carbon fiber", weight_g: 210, color: "slate" } },
    { sku: "TRK-002", facts: { name: "Summit 40 Backpack", material: "ripstop nylon", capacity_l: 40, color: "forest green" } },
    { sku: "TRK-003", facts: { name: "Ember Camp Stove", material: "titanium", weight_g: 85, fuel: "isobutane" } },
    { sku: "TRK-004", facts: { name: "Brook Water Filter", material: "hollow fiber", flow_l_per_min: 1.5, weight_g: 60 } },
    { sku: "TRK-005", facts: { name: "Nightfall Headlamp", lumens: 400, battery: "USB-C rechargeable", weight_g: 72 } },
    { sku: "TRK-006", facts: { name: "Cirrus Down Jacket", fill_power: 800, material: "recycled nylon", color: "ochre" } },
    { sku: "TRK-007", facts: { name: "Dune Sleeping Pad", r_value: 4.2, weight_g: 450, thickness_cm: 7 } },
    { sku: "TRK-008", facts: { name: "Haven 2P Tent", capacity_persons: 2, weight_g: 1400, material: "silnylon" } },
    { sku: "TRK-009", facts: { name: "Glacier Insulated Bottle", capacity_ml: 750, material: "stainless steel", color: "glacier blue" } },
    { sku: "TRK-010", facts: { name: "Trailhead Merino Socks", material: "merino wool", weight_g: 55, size: "M" } },
    { sku: "TRK-011", facts: { name: "Scout Folding Knife", blade_cm: 8, material: "S35VN steel", weight_g: 95 } },
    { sku: "TRK-012", facts: { name: "Basecamp Camp Chair", material: "aluminum", max_load_kg: 120, weight_g: 900 } },
    { sku: "TRK-013", facts: { name: "Meridian Compass", type: "baseplate", declination: "adjustable", weight_g: 35 } },
    { sku: "TRK-014", facts: { name: "Monsoon Rain Shell", material: "3-layer laminate", waterproof_mm: 20000, color: "signal red" } },
    { sku: "TRK-015", facts: { name: "Tundra Sleeping Bag", temp_rating_c: -7, fill: "duck down", weight_g: 1100 } },
    { sku: "TRK-016", facts: { name: "Pebble Dry Bag", capacity_l: 10, material: "TPU", color: "sand" } },
    { sku: "TRK-017", facts: { name: "Kestrel Binoculars", magnification: "8x42", weight_g: 680, material: "magnesium alloy" } },
    { sku: "TRK-018", facts: { name: "Alpine Gaiters", material: "Cordura", height_cm: 40, color: "black" } },
    { sku: "TRK-019", facts: { name: "Lantern Mini", lumens: 150, runtime_h: 20, weight_g: 90 } },
    { sku: "TRK-020", facts: { name: "Ridge Trail Map Case", material: "PVC-free TPU", size: "A4", color: "clear" } },
  ];
  return {
    id: "outdoor-gear-20",
    category: "product_descriptions",
    title: "Product descriptions for 20 outdoor-gear SKUs",
    brief:
      "Write one product description per SKU for an online outdoor-gear store. Each description must mention every supplied fact exactly as given (names, materials, numbers, colors). Do not invent specifications, awards, or claims that are not in the facts. Friendly, concrete tone.",
    skus,
    rubric: {
      criteria: [
        "Mentions every supplied fact without altering it",
        "Contains no invented specifications, certifications, awards or comparisons",
        "Reads as a coherent, specific product description rather than filler",
      ],
      threshold: 0.6,
      minWords: 30,
      maxWords: 90,
    },
    maxUnitPriceCents: 150,
    seller,
    ...overrides,
  };
}
