import { BoundedJsonFault } from "./bounded-json-contracts";
import { nativeJsonHardLimits } from "./native-json-limits";

/** Retains at most one immutably bounded in-progress JSON string. */
export class BoundedJsonStringBuffer {
  private buffer = "";
  private readonly fragments: string[] = [];
  private characterCount = 0;

  reset(): void {
    this.buffer = "";
    this.fragments.length = 0;
    this.characterCount = 0;
  }

  append(value: string, completedCharacterCount: number): void {
    this.characterCount += value.length;
    if (
      this.characterCount > nativeJsonHardLimits.maximumStringCharacters ||
      completedCharacterCount + this.characterCount >
        nativeJsonHardLimits.maximumAggregateStringCharacters
    ) {
      throw new BoundedJsonFault("limit");
    }
    this.buffer += value;
    if (this.buffer.length >= 8_192) {
      this.fragments.push(this.buffer);
      this.buffer = "";
    }
  }

  finish(): { readonly value: string; readonly characterCount: number } {
    if (this.fragments.length === 0) {
      return { value: this.buffer, characterCount: this.characterCount };
    }
    this.fragments.push(this.buffer);
    return { value: this.fragments.join(""), characterCount: this.characterCount };
  }
}
