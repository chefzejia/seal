const digits: Record<string, bigint> = {
  零: 0n,
  〇: 0n,
  壹: 1n,
  贰: 2n,
  貳: 2n,
  叁: 3n,
  參: 3n,
  肆: 4n,
  伍: 5n,
  陆: 6n,
  陸: 6n,
  柒: 7n,
  捌: 8n,
  玖: 9n,
};
const units: Record<string, bigint> = { 拾: 10n, 佰: 100n, 仟: 1000n };
const digitCharacters = "零〇壹贰貳叁參肆伍陆陸柒捌玖";
const unitCharacters = "拾佰仟万萬亿億";
const chinesePattern = new RegExp(
  `(?<![${digitCharacters}${unitCharacters}])(?:[${digitCharacters}][${digitCharacters}${unitCharacters}]*[元圆圓]|[${digitCharacters}]角|[零〇]?[${digitCharacters}]分)[${digitCharacters}元圆圓角分整正]*`,
  "gu",
);
const fractionPattern = new RegExp(
  `^(?:[${digitCharacters}]角(?:[${digitCharacters}]分)?|[零〇]?[${digitCharacters}]分)?$`,
  "u",
);
const arabicPattern =
  /(?<![\d.])(?<!\d,)(?:(人民币|RMB|CNY|[¥￥])\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d.]|,\d)(?:\s*([万萬亿億]?\s*[元圆圓]))?/gu;

function parseSmallSegment(text: string): bigint {
  if (!text) throw new Error("中文金额语法无法确定核对");
  let total = 0n;
  let pendingDigit: bigint | null = null;
  let lastUnit = 10000n;
  let hasDigit = false;
  for (const char of text) {
    if (char in digits) {
      const value = digits[char];
      if (pendingDigit !== null && (pendingDigit !== 0n || value === 0n)) {
        throw new Error("中文金额语法无法确定核对");
      }
      pendingDigit = value;
      hasDigit = true;
    } else if (char in units) {
      const unit = units[char];
      if (pendingDigit === null || pendingDigit === 0n || unit >= lastUnit) {
        throw new Error("中文金额语法无法确定核对");
      }
      total += pendingDigit * unit;
      lastUnit = unit;
      pendingDigit = null;
    } else {
      throw new Error("中文金额语法无法确定核对");
    }
  }
  if (!hasDigit) throw new Error("中文金额语法无法确定核对");
  return total + (pendingDigit ?? 0n);
}

function integer(text: string, allowWan = true): bigint {
  if (!text) throw new Error("中文金额语法无法确定核对");
  const yiIndex = text.lastIndexOf("亿");
  if (yiIndex >= 0) {
    const left = text.slice(0, yiIndex);
    const right = text.slice(yiIndex + 1);
    if (!left || left.includes("亿")) throw new Error("中文金额语法无法确定核对");
    return (
      integer(left, true) * 100000000n +
      (right ? integer(right, true) : 0n)
    );
  }
  const wanIndex = text.lastIndexOf("万");
  if (wanIndex >= 0) {
    if (!allowWan) throw new Error("中文金额语法无法确定核对");
    const left = text.slice(0, wanIndex);
    const right = text.slice(wanIndex + 1);
    if (!left || left.includes("万")) throw new Error("中文金额语法无法确定核对");
    return (
      parseSmallSegment(left) * 10000n +
      (right ? parseSmallSegment(right) : 0n)
    );
  }
  return parseSmallSegment(text);
}

export function chineseMoneyCents(text: string): bigint {
  const normalized = text
    .replaceAll("萬", "万")
    .replaceAll("億", "亿")
    .replace(/[整正]$/u, "");
  const yuan = /[元圆圓]/u.exec(normalized);
  const whole = yuan ? normalized.slice(0, yuan.index) : "";
  const fraction = yuan ? normalized.slice(yuan.index + 1) : normalized;
  if (
    !fractionPattern.test(fraction) ||
    (!yuan && fraction === "") ||
    (yuan &&
      (!/^[零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万亿]+$/u.test(whole) ||
        !/[零〇壹贰貳叁參肆伍陆陸柒捌玖]/u.test(whole)))
  )
    throw new Error("中文金额语法无法确定核对");
  const angle = /([零〇壹贰貳叁參肆伍陆陸柒捌玖])角/u.exec(fraction);
  const cent = /([零〇壹贰貳叁參肆伍陆陸柒捌玖])分/u.exec(fraction);
  return (
    (yuan ? integer(whole) * 100n : 0n) +
    (angle ? digits[angle[1]] * 10n : 0n) +
    (cent ? digits[cent[1]] : 0n)
  );
}

interface ExactDecimal {
  scaled: bigint;
  extraScale: number;
}

function parseArabicAmount(numberText: string, unitText = ""): ExactDecimal {
  const [wholePart, rawFraction = ""] = numberText.replaceAll(",", "").split(".");
  const fraction = rawFraction.replace(/0+$/u, "");
  const normalizedUnit = unitText.replace(/\s+/gu, "");
  const unitExp =
    normalizedUnit.startsWith("亿") || normalizedUnit.startsWith("億")
      ? 8
      : normalizedUnit.startsWith("万") || normalizedUnit.startsWith("萬")
        ? 4
        : 0;
  const digitsValue = BigInt(`${wholePart}${fraction}`);
  const expInCents = unitExp + 2 - fraction.length;
  if (expInCents >= 0) {
    return {
      scaled: digitsValue * 10n ** BigInt(expInCents),
      extraScale: 0,
    };
  }
  return {
    scaled: digitsValue,
    extraScale: -expInCents,
  };
}

function amountsEqual(cents: bigint, arabic: ExactDecimal): boolean {
  if (arabic.extraScale === 0) return cents === arabic.scaled;
  return cents * 10n ** BigInt(arabic.extraScale) === arabic.scaled;
}

/** Amount pairs are ordered literal tokens; this does not infer business fields. */
export function checkMoney(
  blocks: readonly { address: string; text: string }[],
) {
  const containers = new Map<string, string[]>();
  for (const block of blocks) {
    const row = /^(.*\/r:\d+)\/c:\d+/.exec(block.address)?.[1];
    const key = row ?? block.address;
    const values = containers.get(key) ?? [];
    values.push(block.text);
    containers.set(key, values);
  }
  const issues: Array<{
    address: string;
    value: string;
    chinese: string;
    arabic: string;
    reason: string;
  }> = [];
  for (const [address, values] of containers) {
    const text = values.join(" ").normalize("NFKC");
    const chinese = [...text.matchAll(chinesePattern)];
    if (!chinese.length) continue;
    const candidates = [...text.matchAll(arabicPattern)].filter((match) => {
      const hasPrefix = Boolean(match[1]);
      const hasUnit = Boolean(match[3]);
      const trailing = text.slice(match.index! + match[0].length);
      // Do not treat "280万人" / "280 万次" (scale word without currency) as bare yuan.
      if (!hasUnit && /^\s*[万萬亿億]/u.test(trailing)) return false;
      if (hasPrefix || hasUnit) return true;
      const fractionLength = match[2].split(".")[1]?.length ?? 0;
      if (fractionLength > 2) return false;
      return (
        !/[\p{L}\p{N}]/u.test(text[match.index! - 1] ?? "") &&
        !/[\p{L}\p{N}]/u.test(trailing[0] ?? "")
      );
    });
    if (!candidates.length) continue;
    const strong = candidates.filter(
      (match) => match[1] || match[3] || /[.,]/u.test(match[2]),
    );
    const arabic = strong.length === chinese.length ? strong : candidates;
    if (arabic.length !== chinese.length) {
      issues.push({
        address,
        value: text,
        chinese: chinese.map((item) => item[0]).join("；"),
        arabic: arabic.map((item) => item[0].trim()).join("；"),
        reason: "金额字面数量不一致，无法唯一核对",
      });
      continue;
    }
    for (let index = 0; index < chinese.length; index++) {
      const upper = chinese[index][0];
      const lowerMatch = arabic[index];
      const lower = lowerMatch[0].trim();
      let upperCents: bigint;
      try {
        upperCents = chineseMoneyCents(upper);
      } catch {
        issues.push({
          address,
          value: text,
          chinese: upper,
          arabic: lower,
          reason: "中文金额语法无法确定核对",
        });
        continue;
      }
      if (!amountsEqual(upperCents, parseArabicAmount(lowerMatch[2], lowerMatch[3])))
        issues.push({
          address,
          value: text,
          chinese: upper,
          arabic: lower,
          reason: "中文大写金额与阿拉伯数字金额不一致",
        });
    }
  }
  return issues;
}
