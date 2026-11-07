/** Petit client HTTP JSON avec timeout et messages d'erreur lisibles. */

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  method?: "GET" | "POST";
  timeoutMs?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { method = "GET", timeoutMs = 5_000, body, headers = {} } = options;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(`Requête réseau impossible: ${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      text.slice(0, 500),
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError("Réponse JSON invalide", response.status, text.slice(0, 500));
  }
}
