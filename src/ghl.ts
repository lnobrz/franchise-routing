// Thin client for the GoHighLevel API v2 (LeadConnector).
// Auth: a Private Integration token for one sub-account.

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

export class GhlError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GhlClient {
  private userCache: { at: number; byEmail: Map<string, string> } | null = null;
  private pipelineCache: { pipelineId: string; firstStageId: string } | null = null;

  constructor(private token: string, readonly locationId: string) {}

  /** Retries rate limits (429) and server errors with exponential backoff. */
  private async request<T>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: API_VERSION,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });

    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      // Capped so a run always ends well inside STALE_EVENT_MINUTES
      const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250 + Math.random() * 250, 30_000);
      await sleep(wait);
      return this.request<T>(method, path, body, attempt + 1);
    }
    throw new GhlError(`GHL ${method} ${path} failed with ${res.status}`, res.status, text);
  }

  // --- Lookups (cached) ----------------------------------------------------

  /** Maps rep e-mail -> GHL user id, so ops only maintain e-mails in Supabase. */
  async userIdsByEmail(): Promise<Map<string, string>> {
    if (this.userCache && Date.now() - this.userCache.at < 10 * 60_000) return this.userCache.byEmail;
    const data = await this.request<{ users: { id: string; email: string }[] }>(
      'GET',
      `/users/?locationId=${encodeURIComponent(this.locationId)}`,
    );
    const byEmail = new Map(data.users.map((u) => [u.email.toLowerCase(), u.id]));
    this.userCache = { at: Date.now(), byEmail };
    return byEmail;
  }

  async pipeline(name: string): Promise<{ pipelineId: string; firstStageId: string }> {
    if (this.pipelineCache) return this.pipelineCache;
    const data = await this.request<{ pipelines: { id: string; name: string; stages: { id: string }[] }[] }>(
      'GET',
      `/opportunities/pipelines?locationId=${encodeURIComponent(this.locationId)}`,
    );
    const pipeline = data.pipelines.find((p) => p.name === name);
    const firstStage = pipeline?.stages[0];
    if (!pipeline || !firstStage) throw new Error(`Pipeline "${name}" not found or has no stages`);
    this.pipelineCache = { pipelineId: pipeline.id, firstStageId: firstStage.id };
    return this.pipelineCache;
  }

  async customFieldIdsByKey(): Promise<Map<string, string>> {
    const data = await this.request<{ customFields: { id: string; fieldKey: string }[] }>(
      'GET',
      `/locations/${encodeURIComponent(this.locationId)}/customFields`,
    );
    return new Map(data.customFields.map((f) => [f.fieldKey, f.id]));
  }

  // --- Writes ------------------------------------------------------------------

  assignContact(contactId: string, userId: string) {
    return this.request('PUT', `/contacts/${encodeURIComponent(contactId)}`, { assignedTo: userId });
  }

  addTags(contactId: string, tags: string[]) {
    return this.request('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }

  removeTags(contactId: string, tags: string[]) {
    return this.request('DELETE', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  }

  addNote(contactId: string, body: string) {
    return this.request('POST', `/contacts/${encodeURIComponent(contactId)}/notes`, { body });
  }

  async createOpportunity(input: {
    contactId: string;
    name: string;
    pipelineId: string;
    stageId: string;
    assignedTo: string;
  }): Promise<string> {
    const data = await this.request<{ opportunity: { id: string } }>('POST', '/opportunities/', {
      locationId: this.locationId,
      contactId: input.contactId,
      name: input.name,
      pipelineId: input.pipelineId,
      pipelineStageId: input.stageId,
      assignedTo: input.assignedTo,
      status: 'open',
    });
    return data.opportunity.id;
  }

  async upsertContact(input: {
    firstName: string;
    lastName: string;
    email: string;
    customFields: { id: string; field_value: string }[];
  }): Promise<string> {
    const data = await this.request<{ contact: { id: string } }>('POST', '/contacts/upsert', {
      locationId: this.locationId,
      ...input,
    });
    return data.contact.id;
  }
}
