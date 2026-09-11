import Decimal from 'decimal.js';

Decimal.set({ precision: 40, toExpNeg: -30, toExpPos: 40 });

export const D = (v: string | number | Decimal): Decimal => new Decimal(v);

/** 质量单位 → 克 的换算因子 */
export const MASS_TO_G: Record<string, string> = {
  ug: '0.000001',
  mg: '0.001',
  g: '1',
  kg: '1000',
  t: '1000000',
};

export function massToG(value: string | number, unit: string): Decimal {
  const f = MASS_TO_G[unit];
  if (!f) throw new Error(`未知质量单位: ${unit}（支持 ${Object.keys(MASS_TO_G).join('/')}）`);
  return D(value).times(f);
}

/**
 * 浓度/含量单位 → mg/kg 的换算因子。
 * 注：mg/L、ug/L 等体积单位按水基液体密度 1 kg/L 近似换算。
 */
export const CONC_TO_MG_PER_KG: Record<string, string> = {
  'ug/kg': '0.001',
  'mg/kg': '1',
  'g/kg': '1000',
  '%': '10000',
  'ug/L': '0.001',
  'mg/L': '1',
  'g/L': '1000',
  'ng/mL': '0.001',
  'ug/mL': '1',
};

export function concToMgPerKg(value: Decimal, unit: string): Decimal {
  const f = CONC_TO_MG_PER_KG[unit];
  if (!f) throw new Error(`未知含量单位: ${unit}（支持 ${Object.keys(CONC_TO_MG_PER_KG).join('/')}）`);
  return value.times(f);
}
