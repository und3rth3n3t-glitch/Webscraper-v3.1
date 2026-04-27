import type { ColumnType, ColumnFormat } from './types';

const MAX_INFER_LENGTH = 1024;

const DENYLIST_HEADER = [/code$/i, /\bid\b/i, /postcode/i, /phone/i, /reference/i, /\bref$/i];

const ONS_CODE = /^[A-Z]\d{8}$/;
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;
const NULL_MARKERS = new Set(['c', ':', '..', '—', '-', 'n/a', 'na', 'null', 'nil', '']);

const NUMBER_THOUSANDS = /^-?\d{1,3}(,\d{3})*(\.\d+)?$/;
const NUMBER_PLAIN = /^-?\d+(\.\d+)?$/;
const PERCENT = /^-?\d+(\.\d+)?%$/;
const CURRENCY = /^[£$€¥₹][\d,]+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UK_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const BOOL_VALUES = new Set(['yes', 'no', 'true', 'false']);

function isIdLike(v: string): boolean {
  return ONS_CODE.test(v) || POSTCODE.test(v) || (v.startsWith('0') && v.length > 1 && /^\d+$/.test(v));
}

type InferResult = { type: ColumnType; format?: ColumnFormat };

export function inferType(cells: string[], headerPath?: string[]): InferResult {
  const lastHeader = headerPath?.[headerPath.length - 1] ?? '';
  if (DENYLIST_HEADER.some((re) => re.test(lastHeader))) return { type: 'text' };

  const nonNull = cells.filter((c) => !NULL_MARKERS.has(c.trim().toLowerCase()));
  if (nonNull.length === 0) return { type: 'text' };

  const usable = nonNull.filter((c) => c.length <= MAX_INFER_LENGTH);
  if (usable.length === 0) return { type: 'text' };

  if (usable.every((c) => isIdLike(c.trim()))) return { type: 'text' };

  const score = (re: RegExp) => usable.filter((c) => re.test(c.trim())).length / usable.length;

  if (score(PERCENT) >= 0.9) return { type: 'percent', format: { unit: 'percent' } };
  if (score(CURRENCY) >= 0.9) {
    const sym = usable[0].trim()[0];
    return { type: 'currency', format: { symbol: sym } };
  }
  if (usable.filter((c) => BOOL_VALUES.has(c.trim().toLowerCase())).length / usable.length >= 0.9) {
    return { type: 'boolean' };
  }
  if (score(ISO_DATE) >= 0.9) return { type: 'date' };
  if (score(UK_DATE) >= 0.9) return { type: 'date', format: { dayFirst: true } };
  if (score(NUMBER_THOUSANDS) >= 0.9) return { type: 'number', format: { thousands: ',', decimal: '.' } };
  if (score(NUMBER_PLAIN) >= 0.9) return { type: 'number' };

  return { type: 'text' };
}

export function parseValue(
  raw: string,
  type: ColumnType,
  format?: ColumnFormat,
): string | number | boolean | null {
  const t = raw.trim();
  if (NULL_MARKERS.has(t.toLowerCase())) return null;
  if (t.length > MAX_INFER_LENGTH) return t;

  switch (type) {
    case 'number': {
      const cleaned = format?.thousands ? t.replace(new RegExp(`\\${format.thousands}`, 'g'), '') : t;
      const n = Number(cleaned);
      return isNaN(n) ? null : n;
    }
    case 'percent': {
      const n = Number(t.replace('%', ''));
      return isNaN(n) ? null : n;
    }
    case 'currency': {
      const n = Number(t.replace(format?.symbol ?? '', '').replace(/,/g, ''));
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return t.toLowerCase() === 'yes' || t.toLowerCase() === 'true';
    default:
      return t;
  }
}
