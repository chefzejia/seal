export interface InvalidDate { text: string; offset: number; }

export function isValidDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const max = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= max;
}

export function invalidDates(text: string): InvalidDate[] {
  return [...text.matchAll(/(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g)].flatMap(match => {
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    return isValidDate(year, month, day) ? [] : [{ text: match[0], offset: match.index }];
  });
}
