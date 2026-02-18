import { extractSizeHint } from '../sizing/size-hints';

describe('extractSizeHint', () => {
  it('extracts jeans W/L', () => {
    const hint = extractSizeHint('Jeans W32 L34 slim');
    expect(hint).toEqual({ input_label: '32x34', input_system: 'JEANS_WL_IN' });
  });

  it('extracts EU numeric', () => {
    const hint = extractSizeHint('EU 38 dress');
    expect(hint).toEqual({ input_label: '38', input_system: 'EU_NUMERIC' });
  });

  it('extracts alpha sizes', () => {
    const hint = extractSizeHint('Size S top');
    expect(hint).toEqual({ input_label: 'S', input_system: 'ALPHA' });
  });

  it('returns null when no hint', () => {
    expect(extractSizeHint('No size here')).toBeNull();
  });
});
