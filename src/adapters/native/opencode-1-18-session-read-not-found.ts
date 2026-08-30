interface FixedMessageIdentity {
  readonly sessionId: string;
  readonly messageId: string;
}

interface FixedMessageRoute {
  readonly serverUrl: URL;
  readonly directory: string;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string") ||
    expectedKeys.some((key) => !keys.includes(key))
  )
    return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    if (key === "message") {
      if (typeof descriptor.value !== "string") return undefined;
    } else result[key] = descriptor.value;
  }
  return result;
}

function hasConfiguredQuery(url: URL, directory: string): boolean {
  const directoryValues = url.searchParams.getAll("directory");
  const locationValues = url.searchParams.getAll("location[directory]");
  const keys = [...url.searchParams.keys()];
  return (
    directoryValues.length === 1 &&
    directoryValues[0] === directory &&
    locationValues.length <= 1 &&
    locationValues.every((value) => value === directory) &&
    keys.every((key) => key === "directory" || key === "location[directory]") &&
    keys.length === 1 + locationValues.length
  );
}

/** Recognizes only the pinned generated client's correlated fixed-message 404 response. */
export function isAuthoritativeFixedMessageNotFound(
  value: unknown,
  identity: FixedMessageIdentity,
  route: FixedMessageRoute,
): boolean {
  try {
    const envelope = exactDataRecord(value, ["error", "request", "response"]);
    if (
      !envelope ||
      !(envelope.request instanceof Request) ||
      !(envelope.response instanceof Response) ||
      envelope.response.status !== 404 ||
      !/^application\/json(?:;|$)/i.test(envelope.response.headers.get("content-type") ?? "")
    )
      return false;
    const error = exactDataRecord(envelope.error, ["_tag", "sessionID", "messageID", "message"]);
    if (
      error?._tag !== "MessageNotFoundError" ||
      error.sessionID !== identity.sessionId ||
      error.messageID !== identity.messageId
    )
      return false;
    const request = envelope.request;
    const url = new URL(request.url);
    const expectedPath = `/api/session/${encodeURIComponent(identity.sessionId)}/message/${encodeURIComponent(identity.messageId)}`;
    return (
      request.method === "GET" &&
      url.origin === route.serverUrl.origin &&
      url.pathname === expectedPath &&
      url.hash === "" &&
      hasConfiguredQuery(url, route.directory)
    );
  } catch {
    return false;
  }
}
