export interface BlankHint {
  id: string;
  start: number;
  end: number;
  text: string;
  kind: 'underline' | 'bracket' | 'date' | 'placeholder' | 'checkbox' | 'attachment';
}

/** Hints are advisory and confer no permission to edit. */
export function detectBlankHints(address: string, text: string): BlankHint[] {
  const patterns: Array<[BlankHint['kind'], RegExp]> = [
    ['attachment', /【提供[^】]+】|[（(]格式自拟[）)]/g],
    ['underline', /[_＿]{2,}/g],
    ['bracket', /[（(\[【]\s*[）)\]】]|[（(\[【](?:请填写[^）)\]】]*|[^（）()\[\]【】]{1,24}(?:名称|金额|日期|编号))[）)\]】]/g],
    ['date', /(?:^|[^\d])\s*年\s*月\s*日/g],
    ['placeholder', /(?:XX|xx|××)/g],
    ['checkbox', /[□☐☑■√]/g],
  ];
  const candidates = patterns.flatMap(([kind, pattern]) => [...text.matchAll(pattern)].map(match => {
    let start = match.index;
    if (kind === 'date' && match[0][0] !== '年' && !/\s/.test(match[0][0])) start++;
    return { kind, start, end: match.index + match[0].length, text: text.slice(start, match.index + match[0].length) };
  })).sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (!selected.some(existing => candidate.start < existing.end && candidate.end > existing.start)) selected.push(candidate);
  }
  return selected.map((candidate, index) => ({ id: `${address}#${index}`, ...candidate }));
}
