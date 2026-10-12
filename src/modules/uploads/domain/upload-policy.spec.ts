import {
  isKeyOwnedBy,
  objectKeyFor,
  validateUploadRequest,
} from './upload-policy.js';

describe('upload policy', () => {
  it('accepts allow-listed sermon media within limits', () => {
    expect(
      validateUploadRequest({
        purpose: 'SERMON_MEDIA',
        fileName: 'Sunday.MP3',
        contentType: 'audio/mpeg',
        sizeBytes: 1000,
      }),
    ).toMatchObject({ extension: 'mp3', kind: 'AUDIO' });
    expect(
      validateUploadRequest({
        purpose: 'SERMON_MEDIA',
        fileName: 'notes.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 10,
      }).kind,
    ).toBe('DOCX');
  });

  it.each([
    [
      'unsupported type',
      { contentType: 'application/x-msdownload', fileName: 'a.exe' },
      'contentType',
    ],
    [
      'extension mismatch',
      { contentType: 'audio/mpeg', fileName: 'a.mp4' },
      'fileName',
    ],
    [
      'too large',
      {
        contentType: 'audio/mpeg',
        fileName: 'a.mp3',
        sizeBytes: 3 * 1024 ** 3,
      },
      'sizeBytes',
    ],
    [
      'zero size',
      { contentType: 'audio/mpeg', fileName: 'a.mp3', sizeBytes: 0 },
      'sizeBytes',
    ],
  ])('rejects %s', (_label, overrides, field) => {
    expect(() =>
      validateUploadRequest({
        purpose: 'SERMON_MEDIA',
        sizeBytes: 10,
        ...overrides,
      }),
    ).toThrow(
      expect.objectContaining({
        fieldErrors: { [field]: [expect.any(String)] },
      }),
    );
  });

  it('never allows SVG logos (script injection risk)', () => {
    expect(() =>
      validateUploadRequest({
        purpose: 'CHURCH_LOGO',
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 10,
      }),
    ).toThrow();
  });

  it('builds church-scoped keys', () => {
    const key = objectKeyFor('church-1', 'SERMON_MEDIA', 'abc', 'mp3');
    expect(key).toBe('churches/church-1/sermons/abc.mp3');
    expect(isKeyOwnedBy(key, 'church-1')).toBe(true);
    expect(isKeyOwnedBy(key, 'church-2')).toBe(false);
  });
});
