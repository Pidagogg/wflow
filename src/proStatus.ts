// Whether Pro subscriptions can be bought right now — the admin panel's
// "Subscriptions for sale" switch (billing.salesOpen), delivered with the
// public config (/api/auth/config). While sales are closed every account is on
// the free plan and buttons leading to the Pro page say "Pro opens next month"
// instead of promising an upgrade that cannot be completed.
let salesOpen = true;

export function setProSalesOpen(open: boolean) {
  salesOpen = open;
}

export function proSalesOpen() {
  return salesOpen;
}

/** Label for a button that leads to the Pro page. */
export function proCtaLabel(whenOpen: string) {
  return salesOpen ? whenOpen : "Pro opens next month";
}
