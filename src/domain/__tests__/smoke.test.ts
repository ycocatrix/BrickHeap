import { isSupabaseConfigured } from '@/services/env';

describe('env', () => {
  it('is not configured without keys', () => {
    expect(isSupabaseConfigured()).toBe(false);
  });
});
