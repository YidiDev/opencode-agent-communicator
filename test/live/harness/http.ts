function isSuccess(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

export async function requestJson(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), options);
  const text = await response.text();
  if (!isSuccess(response)) {
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
  }
  const value: unknown = JSON.parse(text);
  return value;
}

export function directoryPath(path: string, directory: string): string {
  const url = new URL(path, "http://live-harness.invalid");
  url.searchParams.set("directory", directory);
  return `${url.pathname}${url.search}`;
}
