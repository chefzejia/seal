const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28] as const;

/** GB 32100-2015 Annex B calculation; the accepted example ends in 3. */
export function isValidCreditCode(value: string): boolean {
  if (!/^[0-9A-HJ-NP-RT-UW-Y]{18}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 17; index++) {
    const numeric = alphabet.indexOf(value[index]);
    if (numeric < 0) return false;
    sum += numeric * weights[index];
  }
  const check = (31 - sum % 31) % 31;
  return alphabet[check] === value[17];
}
