import { Model } from "@opencode/plugin/effect";

export interface OpenCodeHostSession {
  readonly id: string;
  readonly parentID?: string | undefined;
  readonly projectID: string;
  readonly agent?: string | undefined;
  readonly model?:
    | {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string | undefined;
      }
    | undefined;
  readonly title?: string | undefined;
  readonly location: { readonly directory: string };
  readonly time: {
    readonly updated: unknown;
    readonly archived?: unknown | undefined;
  };
}

export function parseRequestedModel(value: string | undefined): Model.Ref | undefined {
  if (value === undefined) return undefined;
  try {
    return Model.Ref.parse(value);
  } catch {
    return undefined;
  }
}

export function matchesRequestedIdentity(
  session: OpenCodeHostSession,
  agent: string | undefined,
  model: Model.Ref | undefined,
): boolean {
  return (
    (agent === undefined || session.agent === agent) &&
    (model === undefined ||
      (session.model?.providerID === model.providerID &&
        session.model.id === model.id &&
        session.model.variant === model.variant))
  );
}
