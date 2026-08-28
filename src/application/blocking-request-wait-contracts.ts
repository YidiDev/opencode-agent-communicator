export type BlockingSessionRequestSuccess =
  | {
      readonly request_id: string;
      readonly state: "answered";
      readonly answers: readonly (readonly string[])[];
    }
  | { readonly request_id: string; readonly state: "reached"; readonly evidence?: string };
