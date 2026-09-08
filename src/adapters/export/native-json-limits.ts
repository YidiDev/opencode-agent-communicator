export const nativeJsonHardLimits = Object.freeze({
  maximumNestingDepth: 32,
  maximumNodes: 120_000,
  maximumKeys: 80_000,
  maximumMessages: 2_048,
  maximumParts: 8_192,
  maximumStrings: 100_000,
  maximumStringCharacters: 1_048_576,
  maximumAggregateStringCharacters: 8_388_608,
  maximumNumberCharacters: 256,
});

export type NativeJsonHardLimits = typeof nativeJsonHardLimits;
