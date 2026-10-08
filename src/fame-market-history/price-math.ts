export type Fraction = { numerator: string; denominator: string };
export function fraction(n: bigint, d: bigint): Fraction {
  if (n < 0n || d <= 0n) throw new Error("Invalid nonnegative fraction");
  let a = n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { numerator: String(n / a), denominator: String(d / a) };
}
export function parse(r: Fraction): [bigint, bigint] {
  if (
    !/^(0|[1-9][0-9]*)$/.test(r.numerator) ||
    !/^[1-9][0-9]*$/.test(r.denominator)
  )
    throw new Error("Invalid fraction encoding");
  return [BigInt(r.numerator), BigInt(r.denominator)];
}
export function multiply(a: Fraction, b: Fraction): Fraction {
  const [an, ad] = parse(a),
    [bn, bd] = parse(b);
  return fraction(an * bn, ad * bd);
}
export function add(a: Fraction, b: Fraction): Fraction {
  const [an, ad] = parse(a),
    [bn, bd] = parse(b);
  return fraction(an * bd + bn * ad, ad * bd);
}
export function invert(a: Fraction): Fraction {
  const [n, d] = parse(a);
  return fraction(d, n);
}
/** Round only at the public decimal boundary, never between conversion hops. */
export function decimal(a: Fraction): string {
  const [n, d] = parse(a);
  const s = ((n * 10n ** 18n) / d).toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18)}`;
}
