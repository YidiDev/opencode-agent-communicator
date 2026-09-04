import {
  BoundedJsonFault,
  type JsonFrame as Frame,
  type JsonToken as Token,
} from "./bounded-json-contracts";
import { BoundedJsonStringBuffer } from "./bounded-json-string-buffer";
import { nativeJsonHardLimits } from "./native-json-limits";

export { BoundedJsonFault } from "./bounded-json-contracts";

/** Incremental JSON parser whose retained graph and token work have immutable ceilings. */
export class BoundedJsonParser {
  private readonly frames: Frame[] = [];
  private root: unknown;
  private rootPhase: "value" | "end" = "value";
  private token: Token = "none";
  private tokenBuffer = "";
  private readonly stringBuffer = new BoundedJsonStringBuffer();
  private stringIsKey = false;
  private unicodeDigits = "";
  private literalExpected = "";
  private nodeCount = 0;
  private keyCount = 0;
  private stringCount = 0;
  private aggregateStringCharacters = 0;

  feed(text: string): void {
    let index = 0;
    while (index < text.length) {
      if (this.token === "string") {
        index = this.consumeString(text, index);
        continue;
      }
      if (this.token === "escape" || this.token === "unicode") {
        this.consumeEscape(text[index] ?? "");
        index += 1;
        continue;
      }
      if (this.token === "number" || this.token === "literal") {
        if (this.consumeScalarCharacter(text[index] ?? "")) index += 1;
        continue;
      }
      this.consumeSyntax(text[index] ?? "");
      index += 1;
    }
  }

  finish(): unknown {
    if (this.token === "number") this.finishNumber();
    else if (this.token === "literal" && this.tokenBuffer === this.literalExpected)
      this.finishLiteral();
    else if (this.token !== "none") this.malformed();
    if (this.frames.length !== 0 || this.rootPhase !== "end") this.malformed();
    return this.root;
  }

  private consumeSyntax(character: string): void {
    if (character === " " || character === "\t" || character === "\n" || character === "\r") return;
    const frame = this.frames.at(-1);
    if (frame?.kind === "object" && (frame.phase === "key_or_end" || frame.phase === "key")) {
      this.consumeObjectKey(frame, character);
      return;
    }
    if (frame?.kind === "object" && frame.phase === "colon") {
      if (character !== ":") this.malformed();
      frame.phase = "value";
      return;
    }
    if (frame?.phase === "comma_or_end") {
      this.consumeContainerEnd(frame, character);
      return;
    }
    if (!this.expectsValue()) this.malformed();
    this.consumeValueStart(frame, character);
  }

  private consumeObjectKey(
    frame: Extract<Frame, { readonly kind: "object" }>,
    character: string,
  ): void {
    if (character === "}" && frame.phase === "key_or_end") {
      this.closeContainer();
      return;
    }
    if (character === '"') {
      this.startString(true);
      return;
    }
    this.malformed();
  }

  private consumeValueStart(frame: Frame | undefined, character: string): void {
    if (character === "{") this.openContainer("object");
    else if (character === "[") this.openContainer("array");
    else if (character === '"') this.startString(false);
    else if (character === "t") this.startLiteral("true");
    else if (character === "f") this.startLiteral("false");
    else if (character === "n") this.startLiteral("null");
    else if (character === "-" || /[0-9]/.test(character)) this.startNumber(character);
    else if (character === "]" && frame?.kind === "array" && frame.phase === "value_or_end")
      this.closeContainer();
    else this.malformed();
  }

  private consumeContainerEnd(frame: Frame, character: string): void {
    if (frame.kind === "object") {
      if (character === ",") frame.phase = "key";
      else if (character === "}") this.closeContainer();
      else this.malformed();
      return;
    }
    if (character === ",") frame.phase = "value";
    else if (character === "]") this.closeContainer();
    else this.malformed();
  }

  private expectsValue(): boolean {
    const frame = this.frames.at(-1);
    if (!frame) return this.rootPhase === "value";
    return frame.phase === "value" || frame.phase === "value_or_end";
  }

  private openContainer(kind: "object" | "array"): void {
    if (this.frames.length >= nativeJsonHardLimits.maximumNestingDepth) this.limit();
    if (kind === "object") {
      const value: Record<string, unknown> = Object.create(null);
      this.attach(value);
      this.frames.push({ kind, value, phase: "key_or_end" });
      return;
    }
    const value: unknown[] = [];
    this.attach(value);
    this.frames.push({ kind, value, phase: "value_or_end" });
  }

  private closeContainer(): void {
    if (!this.frames.pop()) this.malformed();
  }

  private attach(value: unknown): void {
    this.nodeCount += 1;
    if (this.nodeCount > nativeJsonHardLimits.maximumNodes) this.limit();
    const frame = this.frames.at(-1);
    if (!frame) {
      if (this.rootPhase !== "value") this.malformed();
      this.root = value;
      this.rootPhase = "end";
      return;
    }
    if (frame.kind === "array") {
      if (frame.phase !== "value" && frame.phase !== "value_or_end") this.malformed();
      frame.value.push(value);
      frame.phase = "comma_or_end";
      return;
    }
    if (frame.phase !== "value" || frame.key === undefined) this.malformed();
    Object.defineProperty(frame.value, frame.key, { value, enumerable: true, configurable: true });
    delete frame.key;
    frame.phase = "comma_or_end";
  }

  private startString(isKey: boolean): void {
    this.token = "string";
    this.stringIsKey = isKey;
    this.stringBuffer.reset();
  }

  private consumeString(text: string, start: number): number {
    let index = start;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) return this.malformed();
      if (text[index] === '"' || text[index] === "\\") break;
      index += 1;
    }
    this.stringBuffer.append(text.slice(start, index), this.aggregateStringCharacters);
    if (index === text.length) return index;
    if (text[index] === '"') {
      this.finishString();
      return index + 1;
    }
    this.token = "escape";
    return index + 1;
  }

  private consumeEscape(character: string): void {
    if (this.token === "unicode") {
      if (!/[0-9a-fA-F]/.test(character)) this.malformed();
      this.unicodeDigits += character;
      if (this.unicodeDigits.length === 4) {
        this.stringBuffer.append(
          String.fromCharCode(Number.parseInt(this.unicodeDigits, 16)),
          this.aggregateStringCharacters,
        );
        this.unicodeDigits = "";
        this.token = "string";
      }
      return;
    }
    const escaped: Readonly<Record<string, string>> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (character === "u") {
      this.token = "unicode";
      return;
    }
    const value = escaped[character];
    if (value === undefined) this.malformed();
    this.stringBuffer.append(value, this.aggregateStringCharacters);
    this.token = "string";
  }

  private finishString(): void {
    const completed = this.stringBuffer.finish();
    this.stringCount += 1;
    this.aggregateStringCharacters += completed.characterCount;
    if (
      this.stringCount > nativeJsonHardLimits.maximumStrings ||
      this.aggregateStringCharacters > nativeJsonHardLimits.maximumAggregateStringCharacters
    ) {
      this.limit();
    }
    this.token = "none";
    if (!this.stringIsKey) {
      this.attach(completed.value);
      return;
    }
    const frame = this.frames.at(-1);
    if (frame?.kind !== "object") this.malformed();
    this.keyCount += 1;
    if (this.keyCount > nativeJsonHardLimits.maximumKeys) this.limit();
    frame.key = completed.value;
    frame.phase = "colon";
  }

  private startLiteral(expected: "true" | "false" | "null"): void {
    this.token = "literal";
    this.literalExpected = expected;
    this.tokenBuffer = expected[0] ?? "";
  }

  private startNumber(first: string): void {
    this.token = "number";
    this.tokenBuffer = first;
  }

  private consumeScalarCharacter(character: string): boolean {
    if (this.token === "literal") {
      if (this.literalExpected.startsWith(this.tokenBuffer + character)) {
        this.tokenBuffer += character;
        return true;
      }
      if (this.tokenBuffer !== this.literalExpected) return this.malformed();
      this.finishLiteral();
      return false;
    }
    if (/[-+eE.0-9]/.test(character)) {
      this.tokenBuffer += character;
      if (this.tokenBuffer.length > nativeJsonHardLimits.maximumNumberCharacters) this.limit();
      return true;
    }
    this.finishNumber();
    return false;
  }

  private finishLiteral(): void {
    const value =
      this.literalExpected === "true" ? true : this.literalExpected === "false" ? false : null;
    this.token = "none";
    this.attach(value);
  }

  private finishNumber(): void {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.tokenBuffer)) this.malformed();
    const value = Number(this.tokenBuffer);
    this.token = "none";
    this.attach(value);
  }

  private malformed(): never {
    throw new BoundedJsonFault("malformed");
  }

  private limit(): never {
    throw new BoundedJsonFault("limit");
  }
}
