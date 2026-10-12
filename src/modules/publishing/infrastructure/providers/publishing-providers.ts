import type {
  PublishInput,
  PublishingProviderPort,
  PublishResult,
} from '../../application/ports/out/publishing.ports.js';

/**
 * Classifies an HTTP failure for a non-idempotent publish call.
 * 4xx: the provider rejected the request, so nothing was posted (definite). 429 is safe to retry.
 * 5xx: the provider may have posted before failing, so the outcome is unknown and is never retried.
 */
function failure(status: number, message: string): PublishResult {
  return {
    ok: false,
    retryable: status === 429,
    definite: status < 500,
    credentialsInvalid: status === 401 || status === 403,
    message: `${status}: ${message}`,
  };
}

const uncertain = (error: unknown): PublishResult => ({
  ok: false,
  retryable: false,
  definite: false,
  credentialsInvalid: false,
  message: `No response from provider: ${(error as Error).message}`,
});

async function call(
  url: string,
  init: RequestInit,
): Promise<{ response: Response } | { error: unknown }> {
  try {
    return {
      response: await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      }),
    };
  } catch (error) {
    return { error };
  }
}

/** Posts to the connected Facebook Page feed. */
export class MetaPagePublisher implements PublishingProviderPort {
  readonly provider = 'META' as const;

  constructor(private readonly graphVersion: string) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const { pageId, pageAccessToken } = input.credentials;
    if (!pageId || !pageAccessToken)
      return {
        ok: false,
        retryable: false,
        definite: true,
        credentialsInvalid: true,
        message: 'Missing page credentials',
      };
    const result = await call(
      `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(pageId)}/feed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          message: input.content.body,
          access_token: pageAccessToken,
        }).toString(),
      },
    );
    if ('error' in result) return uncertain(result.error);
    const body = (await result.response.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!result.response.ok || !body.id)
      return failure(
        result.response.status,
        body.error?.message ?? 'Unknown error',
      );
    return { ok: true, externalId: body.id };
  }
}

/** Creates and sends a Mailchimp campaign to the connected audience. */
export class MailchimpPublisher implements PublishingProviderPort {
  readonly provider = 'EMAIL' as const;

  async publish(input: PublishInput): Promise<PublishResult> {
    const { accessToken, apiEndpoint, listId } = input.credentials;
    if (!accessToken || !apiEndpoint || !listId)
      return {
        ok: false,
        retryable: false,
        definite: true,
        credentialsInvalid: true,
        message: 'Missing Mailchimp credentials',
      };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const base = `${apiEndpoint}/3.0`;

    const list = await call(
      `${base}/lists/${encodeURIComponent(listId)}?fields=campaign_defaults`,
      { headers },
    );
    if ('error' in list) return uncertain(list.error);
    if (!list.response.ok)
      return failure(list.response.status, 'Could not load audience defaults');
    const defaults =
      (
        (await list.response.json().catch(() => ({}))) as {
          campaign_defaults?: { from_name?: string; from_email?: string };
        }
      ).campaign_defaults ?? {};

    const campaign = await call(`${base}/campaigns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'regular',
        recipients: { list_id: listId },
        // The idempotency key in the internal title lets support match a campaign to its publish attempt.
        settings: {
          subject_line: input.content.title,
          title: `abyde:${input.idempotencyKey}`,
          from_name: defaults.from_name,
          reply_to: defaults.from_email,
        },
      }),
    });
    if ('error' in campaign) return uncertain(campaign.error);
    const created = (await campaign.response.json().catch(() => ({}))) as {
      id?: string;
      detail?: string;
    };
    if (!campaign.response.ok || !created.id)
      return failure(
        campaign.response.status,
        created.detail ?? 'Campaign creation failed',
      );

    const content = await call(`${base}/campaigns/${created.id}/content`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        plain_text: input.content.body,
        html: toHtml(input.content.body),
      }),
    });
    if ('error' in content) return uncertain(content.error);
    if (!content.response.ok)
      return this.discard(
        base,
        headers,
        created.id,
        failure(content.response.status, 'Campaign content rejected'),
      );

    const send = await call(`${base}/campaigns/${created.id}/actions/send`, {
      method: 'POST',
      headers,
    });
    if ('error' in send) return uncertain(send.error);
    if (!send.response.ok)
      return this.discard(
        base,
        headers,
        created.id,
        failure(send.response.status, 'Campaign send rejected'),
      );
    return { ok: true, externalId: created.id };
  }

  /** Removes the unsent draft after a definite rejection so retries do not pile up campaigns. */
  private async discard(
    base: string,
    headers: Record<string, string>,
    campaignId: string,
    result: PublishResult,
  ): Promise<PublishResult> {
    if (!result.ok && result.definite) {
      await call(`${base}/campaigns/${campaignId}`, {
        method: 'DELETE',
        headers,
      });
    }
    return result;
  }
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Plain text → minimal safe HTML (content is escaped; no user HTML is ever passed through). */
function toHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');
}
