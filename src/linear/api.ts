/** The subset of `fetch` the Linear client needs, so tests can supply a fake. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const APP_SCOPES = "read,write,app:assignable,app:mentionable";

/** Renew a token this long before Linear says it expires. */
const RENEW_EARLY_MS = 24 * 60 * 60 * 1000;

export class LinearError extends Error {}

/**
 * App-actor tokens from Linear's client-credentials grant (ADR 0007): no user,
 * no seat, valid 30 days, no refresh token. Cached until shortly before expiry
 * and replaced after a 401.
 */
export class AppTokenSource {
  private token?: { value: string; renewAt: number };

  constructor(
    private readonly fetch: Fetch,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    if (this.token && this.now() < this.token.renewAt) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await this.fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: APP_SCOPES }).toString(),
    });
    if (!response.ok) throw new LinearError(`Linear token request failed with ${response.status}`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new LinearError("Linear token response had no access_token");
    const lifetimeMs = (body.expires_in ?? 30 * 24 * 60 * 60) * 1000;
    this.token = { value: body.access_token, renewAt: this.now() + Math.max(lifetimeMs - RENEW_EARLY_MS, 0) };
    return this.token.value;
  }

  invalidate(): void {
    this.token = undefined;
  }
}

/** A minimal Linear GraphQL client acting as the app. */
export class LinearApi {
  constructor(
    private readonly fetch: Fetch,
    private readonly tokens: AppTokenSource,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.tokens.get()}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (response.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (!response.ok || body.errors?.length) {
        throw new LinearError(`Linear GraphQL failed: ${body.errors?.map((e) => e.message).join("; ") ?? response.status}`);
      }
      return body.data as T;
    }
    throw new LinearError("Linear rejected a fresh app token");
  }

  /** Post an activity to an agent session (thought, elicitation, response, error). */
  async postActivity(
    agentSessionId: string,
    type: "thought" | "elicitation" | "response" | "error",
    body: string,
    ephemeral = false,
  ): Promise<void> {
    await this.graphql(
      `mutation PostActivity($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
      { input: { agentSessionId, content: { type, body }, ...(ephemeral ? { ephemeral } : {}) } },
    );
  }

  /** The issue fields routing and the Paperclip task need. */
  async issue(id: string): Promise<LinearIssue> {
    const data = await this.graphql<{ issue: RawIssue }>(
      `query Issue($id: String!) { issue(id: $id) { id identifier title description url project { id } labels { nodes { name } } } }`,
      { id },
    );
    const raw = data.issue;
    return {
      id: raw.id,
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description ?? "",
      url: raw.url,
      projectId: raw.project?.id ?? null,
      labels: raw.labels?.nodes.map((n) => n.name) ?? [],
    };
  }
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  project?: { id: string } | null;
  labels?: { nodes: Array<{ name: string }> };
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  projectId: string | null;
  labels: string[];
}
