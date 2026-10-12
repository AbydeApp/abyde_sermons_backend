import { Church } from './church.entity.js';

describe('Church', () => {
  const create = () =>
    Church.create({
      id: 'c1',
      userId: 'u1',
      name: '  Grace Community Church! ',
      ownerRole: 'Lead Pastor',
    });

  it('derives a slug and sensible AI defaults', () => {
    expect(create().snapshot()).toMatchObject({
      name: 'Grace Community Church!',
      slug: 'grace-community-church',
      preferredBibleTranslation: 'NIV',
      wordsToAvoid: '',
    });
  });

  it('validates colours, website and lengths', () => {
    const church = create();
    expect(() => church.update({ primaryColor: 'red' })).toThrow();
    expect(() => church.update({ website: 'javascript:alert(1)' })).toThrow();
    expect(() =>
      church.update({ additionalAIContext: 'x'.repeat(2001) }),
    ).toThrow();
    expect(() => church.update({ name: '' })).toThrow();
    church.update({
      primaryColor: '#B5502F',
      website: 'https://example.org',
      denomination: '',
    });
    expect(church.snapshot()).toMatchObject({
      primaryColor: '#B5502F',
      website: 'https://example.org',
      denomination: null,
    });
  });

  it('returns the previous logo when replaced', () => {
    const church = create();
    expect(church.replaceLogo('k1')).toBeNull();
    expect(church.replaceLogo('k2')).toBe('k1');
  });
});
