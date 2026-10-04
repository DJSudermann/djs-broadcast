import { describe, expect, it } from 'vitest';
import { resolveChurchToolsTheme } from '../src/theme';

describe('ChurchTools theme resolution', () => {
  it('follows the effective ChurchTools root class', () => {
    expect(resolveChurchToolsTheme(['app dark'], 'light', false)).toBe('dark');
    expect(resolveChurchToolsTheme(['app light'], 'dark', true)).toBe('light');
  });

  it('supports ChurchTools theme storage including the system setting', () => {
    expect(resolveChurchToolsTheme([], 'dark', false)).toBe('dark');
    expect(resolveChurchToolsTheme([], 'system', true)).toBe('dark');
    expect(resolveChurchToolsTheme([], 'system', false)).toBe('light');
  });

  it('supports the ChurchTools darkmode query fallback', () => {
    expect(resolveChurchToolsTheme([], null, false, true)).toBe('dark');
  });
});
