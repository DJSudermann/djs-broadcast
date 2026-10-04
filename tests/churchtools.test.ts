import { churchtoolsClient } from '@churchtools/churchtools-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChurchToolsService, customPermissionDataId, filterRecipientsBySelectedRoles, loginTokenFromResponse, membershipCanBroadcast, selectedAnalyticsRecipients } from '../src/churchtools';
import type { Membership, Recipient, WritableGroup } from '../src/types';

afterEach(() => vi.restoreAllMocks());

describe('ChurchTools login token', () => {
  it('extracts the token from the current API response shape', () => {
    expect(loginTokenFromResponse({ loginToken: 'ct-login-token' })).toBe('ct-login-token');
  });

  it('continues to accept a direct string response', () => {
    expect(loginTokenFromResponse('ct-login-token')).toBe('ct-login-token');
  });

  it('rejects missing or empty login tokens', () => {
    expect(() => loginTokenFromResponse({})).toThrow(/Login-Token/);
    expect(() => loginTokenFromResponse({ loginToken: '  ' })).toThrow(/Login-Token/);
  });
});

describe('ChurchTools custom module permissions', () => {
  it('scopes category and data permissions to the data category', () => {
    expect(customPermissionDataId('view custom category', 42)).toBe(42);
    expect(customPermissionDataId('view custom data', 42)).toBe(42);
    expect(customPermissionDataId('edit custom data', 42)).toBe(42);
  });

  it('does not add a data scope to the module view permission', () => {
    expect(customPermissionDataId('view', 42)).toBeUndefined();
  });
});

describe('Broadcast access from the current user membership', () => {
  const membership: Membership = {
    id: 1,
    groupMemberStatus: 'active',
    groupTypeRoleId: 12,
    group: { domainIdentifier: '5', title: 'Broadcast Test' }
  };
  const group: WritableGroup = {
    id: 5,
    guid: 'group-guid',
    name: 'Broadcast Test',
    color: 'blue',
    roles: [
      { id: 120, groupTypeRoleId: 12, name: 'Schreibend', canWriteChat: true },
      { id: 130, groupTypeRoleId: 13, name: 'Lesend', canWriteChat: false }
    ]
  };

  it('accepts an active, configured role with chat write permission', () => {
    expect(membershipCanBroadcast([membership], group, [12])).toBe(true);
  });

  it('rejects a role without a configured grant or chat write permission', () => {
    expect(membershipCanBroadcast([membership], group, [13])).toBe(false);
    expect(membershipCanBroadcast([{ ...membership, groupTypeRoleId: 13 }], group, [13])).toBe(false);
  });

  it('rejects inactive and unrelated memberships', () => {
    expect(membershipCanBroadcast([{ ...membership, groupMemberStatus: 'waiting' }], group, [12])).toBe(false);
    expect(membershipCanBroadcast([{ ...membership, group: { ...membership.group, domainIdentifier: '6' } }], group, [12])).toBe(false);
  });
});

describe('Analytics recipients', () => {
  const person = (id: number): Recipient => ({ id, guid: `guid-${id}`, name: `Person ${id}`, firstName: '', lastName: '', roleId: 1 });

  it('keeps selected regular recipients but excludes only the sender', () => {
    const members = [person(1), person(2), person(3)];
    const regularRecipientIds = [2, 3];
    const analytics = selectedAnalyticsRecipients(members, [1, 2, 3], 1);
    expect(analytics.map(item => item.id)).toEqual([2, 3]);
    expect(analytics.map(item => item.id).filter(id => regularRecipientIds.includes(id))).toEqual([2, 3]);
  });

  it('uses a regular broadcast recipient once even when it also occurs in the loaded admin members', () => {
    const broadcastRecipient = person(2);
    const analytics = selectedAnalyticsRecipients([broadcastRecipient, person(2)], [2], 1);
    expect(analytics).toEqual([broadcastRecipient]);
  });

  it('resolves configured analytics person ids directly without loading an admin group', async () => {
    const get = vi.spyOn(churchtoolsClient, 'get').mockImplementation(async (uri: string) => {
      if (uri === '/persons/575') return { id: 575, guid: 'person-guid', firstName: 'Max', lastName: 'Muster' } as never;
      throw new Error(`Unexpected request: ${uri}`);
    });

    await expect(new ChurchToolsService().analyticsRecipients([575, 575])).resolves.toEqual([{
      id: 575,
      guid: 'person-guid',
      name: 'Max Muster',
      firstName: 'Max',
      lastName: 'Muster',
      roleId: 0
    }]);
    expect(get).toHaveBeenCalledOnce();
  });
});

describe('Recipient role selection', () => {
  const person = (id: number, roleId: number): Recipient => ({ id, roleId, guid: `guid-${id}`, name: `Person ${id}`, firstName: '', lastName: '' });

  it('keeps only recipients whose group role is selected', () => {
    expect(filterRecipientsBySelectedRoles([person(1, 10), person(2, 20), person(3, 10)], [10]).map(item => item.id)).toEqual([1, 3]);
    expect(filterRecipientsBySelectedRoles([person(1, 10)], []).map(item => item.id)).toEqual([]);
  });
});
