export function metricNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isCostKpi(kpi = {}) {
  return kpi.direction === "lower_better" || /\b(?:cpa|cpl|cpc|cpm|cost|spend|budget)\b/i.test(kpi.kpiName || "");
}

export function kpiDifference(kpi) {
  const target = metricNumber(kpi?.target), actual = metricNumber(kpi?.actual);
  return target === null || actual === null ? null : actual - target;
}

export function kpiAchievement(kpi) {
  const target = metricNumber(kpi?.target), actual = metricNumber(kpi?.actual);
  return isCostKpi(kpi) || target === null || actual === null || target === 0 ? null : (actual / target) * 100;
}

export function previousYearVariance(kpi) {
  const actual = metricNumber(kpi?.actual), previous = metricNumber(kpi?.previousYearActual);
  return actual === null || previous === null || previous === 0 ? null : ((actual - previous) / Math.abs(previous)) * 100;
}
