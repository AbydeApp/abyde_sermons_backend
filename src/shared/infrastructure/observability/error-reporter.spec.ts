import { scrubAttributes } from './error-reporter.js';

describe('scrubAttributes', () => {
  it('removes bodies, cookies, auth headers and query strings from span attributes', () => {
    const attributes: Record<string, unknown> = {
      'http.request.body.data': {
        value: '{"password":"Faith2026!"}',
        type: 'string',
      },
      'http.request.header.cookie': 'abyde_session=secret',
      'http.request.header.authorization': 'Bearer x',
      'url.query': 'code=oauth-code&state=abc',
      'url.full': {
        value:
          'https://api.example/api/v1/integrations/meta/callback?code=oauth-code',
        type: 'string',
      },
      'http.target': '/api/v1/sermons?q=private',
      'http.request.method': 'POST',
      'http.response.status_code': { value: 500, type: 'integer' },
    };
    scrubAttributes(attributes);
    expect(attributes).toEqual({
      'url.full': {
        value: 'https://api.example/api/v1/integrations/meta/callback',
        type: 'string',
      },
      'http.target': '/api/v1/sermons',
      'http.request.method': 'POST',
      'http.response.status_code': { value: 500, type: 'integer' },
    });
    expect(JSON.stringify(attributes)).not.toMatch(
      /Faith2026|secret|oauth-code|private/,
    );
  });
});
