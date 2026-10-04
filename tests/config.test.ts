import { churchtoolsClient } from '@churchtools/churchtools-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationAccessError, ConfigurationStore, normalizeConfiguration } from '../src/config';

afterEach(() => vi.restoreAllMocks());

const storedConfig = {
  version: 1,
  adminGroupId: 10,
  adminRoleIds: [2],
  allowedGroups: [{ groupId: 20, roleIds: [3] }],
  analyticsPersonIds: [],
  updatedBy: 1,
  updatedAt: '2026-10-03T00:00:00.000Z'
};

describe('broadcast configuration', () => {
  it('normalizes ids and removes duplicate or invalid entries', () => {
    expect(normalizeConfiguration({
      version: 9,
      adminGroupId: '10',
      adminRoleIds: [2, '2', 'invalid'],
      allowedGroups: [{ groupId: '20', roleIds: [3, 4, 4] }, { groupId: 21, roleIds: [] }],
      analyticsPersonIds: [7, '7', 8],
      updatedBy: '1',
      updatedAt: '2026-10-03T00:00:00.000Z'
    })).toEqual({
      version: 1,
      adminGroupId: 10,
      adminRoleIds: [2],
      allowedGroups: [{ groupId: 20, roleIds: [3, 4] }],
      analyticsPersonIds: [7, 8],
      updatedBy: 1,
      updatedAt: '2026-10-03T00:00:00.000Z'
    });
  });

  it('rejects incomplete admin configuration', () => {
    expect(normalizeConfiguration({ adminGroupId: 1, adminRoleIds: [], updatedBy: 2 })).toBeNull();
  });

  it('loads configuration from category data without data-value access', async () => {
    vi.spyOn(churchtoolsClient, 'get').mockImplementation(async (uri: string) => {
      if (uri === '/custommodules') return [{ id: 5, shorty: 'djs-broadcast' }] as never;
      if (uri.endsWith('/customdatacategories')) return [{ id: 6, customModuleId: 5, shorty: 'broadcast-configuration', data: JSON.stringify({ ...storedConfig, valueId: 7 }) }] as never;
      throw new Error('custom data values are not readable');
    });
    await expect(new ConfigurationStore().load()).resolves.toMatchObject({
      ...storedConfig,
      moduleId: 5,
      categoryId: 6,
      valueId: 7
    });
  });

  it('never treats an existing but unreadable category as a new installation', async () => {
    vi.spyOn(churchtoolsClient, 'get').mockImplementation(async (uri: string) => {
      if (uri === '/custommodules') return [{ id: 5, shorty: 'djs-broadcast' }] as never;
      if (uri.endsWith('/customdatacategories')) return [{ id: 6, customModuleId: 5, shorty: 'broadcast-configuration' }] as never;
      return [] as never;
    });
    await expect(new ConfigurationStore().load()).rejects.toBeInstanceOf(ConfigurationAccessError);
  });

  it('updates only the actual configuration value', async () => {
    const put = vi.spyOn(churchtoolsClient, 'put').mockResolvedValue(undefined as never);
    await new ConfigurationStore().save({
      ...storedConfig,
      version: 1,
      moduleId: 5,
      categoryId: 6,
      valueId: 7
    });
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toBe('/custommodules/5/customdatacategories/6/customdatavalues/7');
  });

  it('migrates category-only fallback configuration into a real value on save', async () => {
    const post = vi.spyOn(churchtoolsClient, 'post').mockResolvedValue({ id: 8 } as never);
    await expect(new ConfigurationStore().save({
      ...storedConfig,
      version: 1,
      moduleId: 5,
      categoryId: 6,
      valueId: 0
    })).resolves.toMatchObject({ valueId: 8 });
    expect(post.mock.calls[0]?.[0]).toBe('/custommodules/5/customdatacategories/6/customdatavalues');
  });
});
