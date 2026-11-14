import { clampQuantity, normalizeSearch, parseQuantityInput } from '../quantity';

describe('clampQuantity', () => {
  it('clamps and rounds', () => {
    expect(clampQuantity(-3)).toBe(0);
    expect(clampQuantity(12000)).toBe(9999);
    expect(clampQuantity(2.6)).toBe(3);
    expect(clampQuantity(5, 1, 4)).toBe(4);
    expect(clampQuantity(Number.NaN, 1, 4)).toBe(1);
  });
});

describe('parseQuantityInput', () => {
  it('accepts 120 typed in one entry', () => {
    expect(parseQuantityInput('120', 3)).toBe(120);
  });
  it('clamps to min..max', () => {
    expect(parseQuantityInput('12000', 3)).toBe(9999);
    expect(parseQuantityInput('0', 3, 1, 50)).toBe(1);
    expect(parseQuantityInput('99', 3, 0, 50)).toBe(50);
  });
  it('ignores spaces', () => {
    expect(parseQuantityInput(' 1 234 ', 3)).toBe(1234);
  });
  it('reverts non-numeric input', () => {
    expect(parseQuantityInput('', 7)).toBe(7);
    expect(parseQuantityInput('abc', 7)).toBe(7);
    expect(parseQuantityInput('-4', 7)).toBe(7);
    expect(parseQuantityInput('3.5', 7)).toBe(7);
  });
});

describe('normalizeSearch', () => {
  it('removes accents and case', () => {
    expect(normalizeSearch('  Gris Bleuté ')).toBe('gris bleute');
    expect(normalizeSearch('ÉLODIE')).toBe('elodie');
  });
});
