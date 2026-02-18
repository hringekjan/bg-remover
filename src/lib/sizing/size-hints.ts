// services/bg-remover/src/lib/sizing/size-hints.ts

export type SizeHint = {
  input_label: string;
  input_system:
    | 'ALPHA'
    | 'EU_NUMERIC'
    | 'US_NUMERIC'
    | 'UK_NUMERIC'
    | 'JEANS_WL_IN';
};

const RX = {
  jeansWL: /\b(?:W\s*)?(\d{2})\s*(?:[x×\/]|(?:\s*L\s*))\s*(?:L\s*)?(\d{2})\b/i,
  euNumeric: /\bEU\s*(\d{2})\b/i,
  usNumeric: /\bUS\s*(\d{1,2})\b/i,
  ukNumeric: /\bUK\s*(\d{1,2})\b/i,
  alpha: /\b(XXS|XS|S|M|L|XL|2XL|3XL|4XL)\b/i,
};

export function extractSizeHint(text: string | undefined | null): SizeHint | null {
  if (!text) return null;

  const source = text.trim();
  if (!source) return null;

  const jeans = source.match(RX.jeansWL);
  if (jeans) {
    return { input_label: `${jeans[1]}x${jeans[2]}`, input_system: 'JEANS_WL_IN' };
  }

  const eu = source.match(RX.euNumeric);
  if (eu) {
    return { input_label: eu[1], input_system: 'EU_NUMERIC' };
  }

  const us = source.match(RX.usNumeric);
  if (us) {
    return { input_label: us[1], input_system: 'US_NUMERIC' };
  }

  const uk = source.match(RX.ukNumeric);
  if (uk) {
    return { input_label: uk[1], input_system: 'UK_NUMERIC' };
  }

  const alpha = source.match(RX.alpha);
  if (alpha) {
    return { input_label: alpha[1].toUpperCase(), input_system: 'ALPHA' };
  }

  return null;
}
