export function formatCurrency(value: number, currencyCode: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
  }).format(value);
}
