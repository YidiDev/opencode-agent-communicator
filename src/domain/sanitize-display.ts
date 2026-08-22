const escapeCode = 0x1b;
const bellCode = 0x07;
const stringTerminatorCode = 0x9c;

function characterWidth(value: string, index: number): number {
  const point = value.codePointAt(index);
  return point !== undefined && point > 0xffff ? 2 : 1;
}

function consumeControlSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function consumeTerminalString(value: string, start: number, canEndWithBell: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((canEndWithBell && code === bellCode) || code === stringTerminatorCode) return index + 1;
    if (code === escapeCode && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function consumeEscape(value: string, index: number): number {
  const introducer = value.charCodeAt(index + 1);
  if (introducer === 0x5b) return consumeControlSequence(value, index + 2);
  if (introducer === 0x5d) return consumeTerminalString(value, index + 2, true);
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
    return consumeTerminalString(value, index + 2, false);
  }
  return Math.min(value.length, index + 1 + characterWidth(value, index + 1));
}

function isUnsafeDisplayControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x206f)
  );
}

export function sanitizeDisplayTitle(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    if (code === undefined) break;
    if (code === escapeCode) {
      index = consumeEscape(value, index);
    } else if (code === 0x9b) {
      index = consumeControlSequence(value, index + 1);
    } else if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeTerminalString(value, index + 1, code === 0x9d);
    } else {
      const width = characterWidth(value, index);
      if (!isUnsafeDisplayControl(code)) result += value.slice(index, index + width);
      index += width;
    }
  }
  return result;
}
