import {
  exportKeys as keys,
  isExportNumber as number,
  exportRecord as record,
  isExportString as string,
} from "./native-export-shape";

export function validNativeToolState(value: unknown): boolean {
  const state = record(value);
  if (!state || !string(state.status) || !record(state.input)) return false;
  if (state.status === "pending") {
    return keys(state, ["status", "input", "raw"]) && string(state.raw);
  }
  const valueTime = record(state.time);
  if (state.status === "running") {
    return (
      keys(state, ["status", "input", "time"], ["title", "metadata"]) &&
      !!valueTime &&
      keys(valueTime, ["start"]) &&
      number(valueTime.start) &&
      (state.title === undefined || string(state.title))
    );
  }
  if (state.status === "completed") {
    return (
      keys(state, ["status", "input", "output", "title", "metadata", "time"], ["attachments"]) &&
      string(state.output) &&
      string(state.title) &&
      !!record(state.metadata) &&
      !!valueTime &&
      keys(valueTime, ["start", "end"], ["compacted"]) &&
      number(valueTime.start) &&
      number(valueTime.end) &&
      (valueTime.compacted === undefined || number(valueTime.compacted))
    );
  }
  if (state.status === "error") {
    return (
      keys(state, ["status", "input", "error", "time"], ["metadata"]) &&
      string(state.error) &&
      !!valueTime &&
      keys(valueTime, ["start", "end"]) &&
      number(valueTime.start) &&
      number(valueTime.end)
    );
  }
  return false;
}
