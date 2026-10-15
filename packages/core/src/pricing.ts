export interface PricingConfig {
  rubPerJpy: number;
  markup: number;
  planFeeJpy: number;
}

export function costKopecks(priceJpy: number, cfg: PricingConfig): number {
  const rub = (priceJpy + cfg.planFeeJpy) * cfg.rubPerJpy * (1 + cfg.markup);
  return Math.round(rub * 100);
}

export function formatRub(kopecks: number): string {
  const rub = (kopecks / 100).toFixed(2).replace('.', ',');
  return `${rub} ₽`;
}
