import {
  DEFAULT_VIDEO_SETTINGS,
  isAnimatedCaptionStyle,
  mergeVideoSettings,
  normalizeVideoSettings,
} from './video-settings.js';

describe('video settings', () => {
  it('reads stored settings leniently, defaulting anything unknown', () => {
    expect(normalizeVideoSettings(undefined)).toEqual(DEFAULT_VIDEO_SETTINGS);
    expect(
      normalizeVideoSettings({
        hookStyle: 'QUESTION',
        captionStyle: 'SPARKLE',
        outroEnabled: false,
        showChurchName: 'yes',
      }),
    ).toEqual({
      ...DEFAULT_VIDEO_SETTINGS,
      hookStyle: 'QUESTION',
      outroEnabled: false,
    });
  });

  it('applies updates strictly', () => {
    expect(
      mergeVideoSettings(DEFAULT_VIDEO_SETTINGS, { logoPosition: 'none' }),
    ).toEqual({ ...DEFAULT_VIDEO_SETTINGS, logoPosition: 'none' });
    expect(() =>
      mergeVideoSettings(DEFAULT_VIDEO_SETTINGS, {
        captionPosition: 'left' as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('treats every caption style but CLEAN as animated', () => {
    expect(isAnimatedCaptionStyle('CLEAN')).toBe(false);
    expect(isAnimatedCaptionStyle('WORD_HIGHLIGHT')).toBe(true);
  });
});
