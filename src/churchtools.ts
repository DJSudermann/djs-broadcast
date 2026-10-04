import { churchtoolsClient } from '@churchtools/churchtools-client';
import { htmlToPlainText, templateToHtml } from './template';
import type {
  BroadcastConfiguration,
  Group,
  GroupRole,
  Membership,
  Person,
  PermissionSyncResult,
  PlaceholderItem,
  Recipient,
  StoredBroadcastConfiguration,
  WritableGroup
} from './types';

type LoginTokenResponse = string | { loginToken?: unknown };

export function loginTokenFromResponse(response: LoginTokenResponse): string {
  const loginToken = typeof response === 'string' ? response : response.loginToken;
  if (typeof loginToken !== 'string' || !loginToken.trim()) {
    throw new Error('ChurchTools hat keinen gültigen Login-Token zurückgegeben.');
  }
  return loginToken;
}

function groupId(membership: Membership): number {
  return Number(membership.group.domainIdentifier);
}

function roleId(role: GroupRole): number {
  return Number(role.groupTypeRoleId ?? role.id);
}

function memberPersonId(member: Membership): number {
  return Number(member.person?.domainIdentifier ?? member.personId);
}

function activeMembershipForGroup(memberships: Membership[], searchedGroupId: number): Membership | undefined {
  return memberships.find(membership =>
    membership.groupMemberStatus === 'active' && groupId(membership) === searchedGroupId
  );
}

export function membershipCanBroadcast(
  memberships: Membership[],
  group: WritableGroup,
  allowedRoleIds: number[]
): boolean {
  const membership = activeMembershipForGroup(memberships, group.id);
  if (!membership) return false;
  const currentRoleId = Number(membership.groupTypeRoleId);
  if (!allowedRoleIds.includes(currentRoleId)) return false;
  return group.roles.some(role => roleId(role) === currentRoleId && role.canWriteChat === true);
}

export function selectedAnalyticsRecipients(
  members: Recipient[],
  selectedPersonIds: number[],
  senderId: number
): Recipient[] {
  const selected = new Set(selectedPersonIds);
  return [...new Map(
    members
      .filter(person => person.id !== senderId && selected.has(person.id))
      .map(person => [person.id, person])
  ).values()];
}

export function filterRecipientsBySelectedRoles(
  recipients: Recipient[],
  selectedRoleIds: number[]
): Recipient[] {
  const selected = new Set(selectedRoleIds);
  return recipients.filter(recipient => selected.has(recipient.roleId));
}

function writableGroup(group: Group): WritableGroup {
  return {
    id: Number(group.id),
    guid: group.guid || '',
    name: group.name,
    color: group.information?.color || 'accent',
    chatStatus: group.information?.chatStatus,
    roles: (group.roles || []).filter(role => role.isActive !== false)
  };
}

interface GlobalPermissions {
  churchcore?: {
    'administer persons'?: boolean;
    'administer custom modules'?: boolean;
  };
  [key: string]: unknown;
}

interface LegacyAuthDefinition {
  id: number | string;
  auth?: string;
  modulename?: string;
  datenfeld?: string | null;
}

interface LegacyPermissionDomain {
  id?: number | string;
  auth?: Record<string, number | string | Record<string, number | string>>;
}

interface LegacyPermissionData {
  auth_table_plain?: Record<string, LegacyAuthDefinition> | LegacyAuthDefinition[];
  auth_table?: Record<string, Record<string, LegacyAuthDefinition>>;
  churchauth?: {
    groupMemberstatus?: Record<string, LegacyPermissionDomain>;
  };
}

export function customPermissionDataId(
  permissionName: string,
  categoryId: number
): number | undefined {
  return permissionName.includes('custom category') || permissionName.includes('custom data')
    ? categoryId
    : undefined;
}

async function mapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export class ChurchToolsService {
  private legacyCsrfToken = '';

  private async legacyApi<T>(module: string, func: string, params: Record<string, unknown> = {}, allowEmpty = false): Promise<T> {
    if (!this.legacyCsrfToken) this.legacyCsrfToken = await churchtoolsClient.get<string>('/csrftoken');
    const baseUrl = churchtoolsClient.getBaseUrl();
    if (!baseUrl) throw new Error('ChurchTools base_url fehlt.');
    const body = new URLSearchParams({ func });
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(key, typeof value === 'string' ? value : String(value));
    }
    const response = await globalThis.fetch(`${baseUrl}/?q=${encodeURIComponent(module)}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'CSRF-Token': this.legacyCsrfToken,
        'X-OnlyAuthenticated': '1'
      },
      body: body.toString()
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${module}/${func}: HTTP ${response.status}.`);
    if (!text.trim()) {
      if (allowEmpty) return undefined as T;
      throw new Error(`${module}/${func}: HTTP ${response.status}, leere Antwort.`);
    }
    let envelope: unknown;
    try { envelope = JSON.parse(text); }
    catch { throw new Error(`${module}/${func}: ungültige JSON-Antwort.`); }
    if (!envelope || typeof envelope !== 'object') throw new Error(`${module}/${func}: ungültige Antwort.`);
    const result = envelope as { status?: unknown; data?: unknown; message?: unknown };
    if (result.status !== 'success') {
      const message = typeof result.message === 'string' ? `: ${result.message}` : '';
      throw new Error(`${module}/${func}: Legacy-Status ${String(result.status || 'unbekannt')}${message}.`);
    }
    return result.data as T;
  }

  async currentUser(): Promise<Person> {
    return churchtoolsClient.get<Person>('/whoami');
  }

  async person(id: number): Promise<Person> {
    return churchtoolsClient.get<Person>(`/persons/${id}`);
  }

  async analyticsRecipients(personIds: number[]): Promise<Recipient[]> {
    const ids = [...new Set(personIds.filter(Number.isSafeInteger))];
    const recipients = await mapLimit(ids, 4, async id => {
      try {
        const person = await this.person(id);
        if (!person.guid) return null;
        const firstName = person.firstName || '';
        const lastName = person.lastName || '';
        return {
          id: person.id,
          guid: person.guid,
          name: [firstName, lastName].filter(Boolean).join(' ') || `Person ${person.id}`,
          firstName,
          lastName,
          roleId: 0
        } satisfies Recipient;
      } catch {
        return null;
      }
    });
    return recipients.filter((recipient): recipient is Recipient => recipient !== null);
  }

  async group(id: number): Promise<WritableGroup> {
    const group = await churchtoolsClient.get<Group>(`/groups/${id}?include[]=roles`);
    const roles = group.roles?.length
      ? group.roles
      : await churchtoolsClient.get<GroupRole[]>(`/groups/${id}/roles`);
    return writableGroup({ ...group, id, roles });
  }

  async ownActiveGroups(user: Person): Promise<Array<WritableGroup & { currentRoleId: number }>> {
    const memberships = (await this.ownActiveMemberships(user.id)).filter(
      membership => membership.groupMemberStatus === 'active' && Number.isSafeInteger(groupId(membership))
    );
    const groups = await mapLimit(memberships, 6, async membership => {
      try {
        const group = await this.group(groupId(membership));
        return { ...group, currentRoleId: Number(membership.groupTypeRoleId) };
      } catch {
        return null;
      }
    });
    return groups
      .filter((group): group is WritableGroup & { currentRoleId: number } => group !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async ownActiveMemberships(userId: number): Promise<Membership[]> {
    return (await churchtoolsClient.get<Membership[]>(`/persons/${userId}/groups`)).filter(
      membership => membership.groupMemberStatus === 'active' && Number.isSafeInteger(groupId(membership))
    );
  }

  async visibleGroups(): Promise<WritableGroup[]> {
    const groups = await churchtoolsClient.getAllPages<Group>('/groups', { 'include[]': ['roles'] }, 100);
    return mapLimit(groups, 6, async group => {
      try {
        return group.roles?.length ? writableGroup(group) : await this.group(Number(group.id));
      } catch {
        return null;
      }
    }).then(items => items
      .filter((group): group is WritableGroup => group !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'de')));
  }

  async configuredGroups(config: BroadcastConfiguration): Promise<WritableGroup[]> {
    const ids = [...new Set([config.adminGroupId, ...config.allowedGroups.map(item => item.groupId)])];
    const groups = await mapLimit(ids, 6, async id => {
      try { return await this.group(id); }
      catch { return null; }
    });
    return groups.filter((group): group is WritableGroup => group !== null);
  }

  async hasConfiguredRole(groupId: number, userId: number, allowedRoleIds: number[]): Promise<boolean> {
    if (!allowedRoleIds.length) return false;
    const membership = activeMembershipForGroup(await this.ownActiveMemberships(userId), groupId);
    return Boolean(membership && allowedRoleIds.includes(Number(membership.groupTypeRoleId)));
  }

  async isConfigurationAdmin(config: BroadcastConfiguration, userId: number): Promise<boolean> {
    return this.hasConfiguredRole(config.adminGroupId, userId, config.adminRoleIds);
  }

  async writableGroups(user: Person, config: BroadcastConfiguration): Promise<WritableGroup[]> {
    const memberships = await this.ownActiveMemberships(user.id);
    return this.writableGroupsFromMemberships(memberships, config);
  }

  async configurationAccess(user: Person, config: BroadcastConfiguration): Promise<{ isAdmin: boolean; groups: WritableGroup[] }> {
    const memberships = await this.ownActiveMemberships(user.id);
    const adminMembership = activeMembershipForGroup(memberships, config.adminGroupId);
    const isAdmin = Boolean(adminMembership && config.adminRoleIds.includes(Number(adminMembership.groupTypeRoleId)));
    const groups = await this.writableGroupsFromMemberships(memberships, config);
    return { isAdmin, groups };
  }

  private async writableGroupsFromMemberships(
    memberships: Membership[],
    config: BroadcastConfiguration
  ): Promise<WritableGroup[]> {
    const relevant = config.allowedGroups.filter(access => {
      const membership = activeMembershipForGroup(memberships, access.groupId);
      return Boolean(membership && access.roleIds.includes(Number(membership.groupTypeRoleId)));
    });
    const groups = await mapLimit(relevant, 6, async access => {
      const id = access.groupId;
      try {
        const group = await this.group(id);
        return membershipCanBroadcast(memberships, group, access.roleIds) ? group : null;
      } catch {
        return null;
      }
    });
    return groups.filter((group): group is WritableGroup => group !== null).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async assertCanBroadcast(groupId: number, userId: number, config: BroadcastConfiguration): Promise<void> {
    const access = config.allowedGroups.find(item => item.groupId === groupId);
    if (!access) {
      throw new Error('Deine aktuelle Rolle ist für Broadcasts in dieser Gruppe nicht freigegeben.');
    }
    const [memberships, group] = await Promise.all([this.ownActiveMemberships(userId), this.group(groupId)]);
    const membership = activeMembershipForGroup(memberships, groupId);
    if (!membership || !access.roleIds.includes(Number(membership.groupTypeRoleId))) {
      throw new Error('Deine aktuelle Rolle ist für Broadcasts in dieser Gruppe nicht freigegeben.');
    }
    if (!membershipCanBroadcast(memberships, group, access.roleIds)) {
      throw new Error('Du hast in dieser Gruppe keine Chat-Schreibberechtigung.');
    }
  }

  async assertCanWrite(groupId: number, userId: number): Promise<void> {
    const [memberships, group] = await Promise.all([this.ownActiveMemberships(userId), this.group(groupId)]);
    const membership = activeMembershipForGroup(memberships, groupId);
    const currentRoleId = Number(membership?.groupTypeRoleId);
    if (!membership || !group.roles.some(role => roleId(role) === currentRoleId && role.canWriteChat === true)) {
      throw new Error('Du hast in dieser Gruppe keine Chat-Schreibberechtigung.');
    }
  }

  async recipients(groupId: number, currentUserId: number, selectedRoleIds: number[], config: BroadcastConfiguration): Promise<Recipient[]> {
    await this.assertCanBroadcast(groupId, currentUserId, config);
    if (!selectedRoleIds.length) return [];
    const recipients: Recipient[] = [];
    let page = 1;
    while (page <= 100) {
      const params = new URLSearchParams({ page: String(page), limit: '100', allowed_chat_users_only: 'true' });
      params.append('group_member_statuses[]', 'active');
      const members = await churchtoolsClient.get<Membership[]>(`/groups/${groupId}/members?${params.toString()}`);
      for (const member of members) {
        const id = memberPersonId(member);
        const attributes = member.person?.domainAttributes;
        const guid = attributes?.guid;
        if (!id || !guid || attributes?.isArchived || id === currentUserId) continue;
        recipients.push({
          id,
          guid,
          name: member.person?.title || [attributes.firstName, attributes.lastName].filter(Boolean).join(' ') || `Person ${id}`,
          firstName: attributes.firstName || '',
          lastName: attributes.lastName || '',
          roleId: Number(member.groupTypeRoleId)
        });
      }
      if (members.length < 100) break;
      page++;
    }
    return filterRecipientsBySelectedRoles(
      [...new Map(recipients.map(recipient => [recipient.id, recipient])).values()],
      selectedRoleIds
    );
  }

  async placeholders(groupId: number, userId: number, config: BroadcastConfiguration): Promise<PlaceholderItem[]> {
    await this.assertCanBroadcast(groupId, userId, config);
    return churchtoolsClient.get<PlaceholderItem[]>(`/placeholders/group/${groupId}`);
  }

  async activeChatMembers(groupId: number): Promise<Recipient[]> {
    const recipients: Recipient[] = [];
    let page = 1;
    while (page <= 100) {
      const members = await churchtoolsClient.get<Membership[]>(
        `/groups/${groupId}/members?page=${page}&limit=100&group_member_statuses[]=active&allowed_chat_users_only=true`
      );
      for (const member of members) {
        const attributes = member.person?.domainAttributes;
        const id = memberPersonId(member);
        if (!id || !attributes?.guid || attributes.isArchived) continue;
        recipients.push({
          id,
          guid: attributes.guid,
          name: member.person?.title || [attributes.firstName, attributes.lastName].filter(Boolean).join(' ') || `Person ${id}`,
          firstName: attributes.firstName || '',
          lastName: attributes.lastName || '',
          roleId: Number(member.groupTypeRoleId)
        });
      }
      if (members.length < 100) break;
      page++;
    }
    return [...new Map(recipients.map(person => [person.id, person])).values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async globalPermissions(): Promise<GlobalPermissions> {
    return churchtoolsClient.get<GlobalPermissions>('/permissions/global');
  }

  async canManagePermissions(): Promise<boolean> {
    const permissions = await this.globalPermissions();
    // Der von ChurchTools bereitgestellte saveAuth-Endpunkt verlangt dieses Recht.
    return Boolean(permissions.churchcore?.['administer persons']);
  }

  async canInitializeConfiguration(): Promise<boolean> {
    const permissions = await this.globalPermissions();
    return Boolean(
      permissions.churchcore?.['administer persons'] ||
      permissions.churchcore?.['administer custom modules']
    );
  }

  async syncModuleViewPermissions(
    previous: BroadcastConfiguration | null,
    next: BroadcastConfiguration,
    groups: WritableGroup[]
  ): Promise<PermissionSyncResult> {
    if (!(await this.canManagePermissions())) {
      return {
        attempted: false,
        changedRoles: 0,
        warning: 'Die Konfiguration wurde gespeichert. Dir fehlt jedoch das ChurchTools-Recht, Modulberechtigungen zu vergeben; das native Anzeigen-Recht wurde daher nicht automatisch geändert.'
      };
    }

    const groupById = new Map(groups.map(group => [group.id, group]));
    const roleAccess = (config: BroadcastConfiguration | null): Map<number, 'admin' | 'user'> => {
      const result = new Map<number, 'admin' | 'user'>();
      if (!config) return result;
      const selections = [
        { groupId: config.adminGroupId, roleIds: config.adminRoleIds, level: 'admin' as const },
        ...config.allowedGroups.map(access => ({ ...access, level: 'user' as const }))
      ];
      for (const selection of selections) {
        const group = groupById.get(selection.groupId);
        for (const role of group?.roles || []) {
          if (!selection.roleIds.includes(roleId(role))) continue;
          const domainId = Number(role.id);
          if (selection.level === 'admin' || !result.has(domainId)) result.set(domainId, selection.level);
        }
      }
      return result;
    };

    const before = roleAccess(previous);
    const desired = roleAccess(next);
    const affected = new Set([...before.keys(), ...desired.keys()]);
    if (!affected.size) return { attempted: true, changedRoles: 0 };

    const extensionKey = 'djs-broadcast';
    const permissionMaster = await this.legacyApi<LegacyPermissionData>('churchauth/ajax', 'getMasterData');
    const domains = permissionMaster.churchauth?.groupMemberstatus || {};
    const groupedDefinitions = permissionMaster.auth_table?.[extensionKey];
    const definitions = Array.isArray(permissionMaster.auth_table_plain)
      ? permissionMaster.auth_table_plain
      : Object.values(permissionMaster.auth_table_plain || {});
    const extensionPermissions = groupedDefinitions
      ? Object.values(groupedDefinitions)
      : definitions.filter(definition => definition.modulename === extensionKey);
    const permission = (name: string) => extensionPermissions.find(definition => definition.auth === name);
    const viewPermission = permission('view');
    if (!viewPermission) {
      return {
        attempted: true,
        changedRoles: 0,
        warning: 'ChurchTools hat das native Anzeigen-Recht des Broadcast-Moduls nicht in der Rechteverwaltung bereitgestellt. Die interne Rollenprüfung bleibt aktiv.'
      };
    }

    const categoryId = Number((next as Partial<StoredBroadcastConfiguration>).categoryId);
    const customDataId = customPermissionDataId('view custom data', categoryId);
    const permissionRules = [
      { definition: viewPermission, dataId: undefined, minimum: 'user' as const },
      { definition: permission('view custom category'), dataId: customPermissionDataId('view custom category', categoryId), minimum: 'user' as const },
      { definition: permission('view custom data'), dataId: customDataId, minimum: 'user' as const },
      { definition: permission('edit custom category'), dataId: customPermissionDataId('edit custom category', categoryId), minimum: 'admin' as const },
      { definition: permission('edit custom data'), dataId: customPermissionDataId('edit custom data', categoryId), minimum: 'admin' as const }
    ].filter(rule => rule.definition && (rule.dataId === undefined || Number.isSafeInteger(rule.dataId)));

    let changedRoles = 0;
    for (const domainId of affected) {
      const existing = domains[String(domainId)]?.auth || {};
      const updated = { ...existing };
      let changed = false;
      for (const rule of permissionRules) {
        const permissionId = String(rule.definition!.id);
        const desiredLevel = desired.get(domainId);
        const shouldHavePermission = desiredLevel === 'admin' || (desiredLevel === 'user' && rule.minimum === 'user');
        if (rule.dataId === undefined) {
          const hasPermission = Object.hasOwn(updated, permissionId);
          if (hasPermission === shouldHavePermission) continue;
          if (shouldHavePermission) updated[permissionId] = permissionId;
          else delete updated[permissionId];
          changed = true;
          continue;
        }
        const current = updated[permissionId];
        const data = current && typeof current === 'object' ? { ...current } : {};
        const dataId = String(rule.dataId);
        const hasPermission = Object.hasOwn(data, dataId) || Object.hasOwn(data, '-1');
        if (shouldHavePermission && !hasPermission) { data[dataId] = dataId; changed = true; }
        if (!shouldHavePermission && Object.hasOwn(data, dataId)) { delete data[dataId]; changed = true; }
        if (Object.keys(data).length) updated[permissionId] = data;
        else if (current && typeof current === 'object') delete updated[permissionId];
      }
      if (!changed) continue;
      const payload: Array<{ auth_id: string; daten_id?: string | number }> = [];
      for (const [authId, data] of Object.entries(updated)) {
        // churchauth kann zusätzlich interne, nicht durch saveAuth verwaltbare Schlüssel liefern.
        if (!/^\d+$/.test(authId)) continue;
        if (data && typeof data === 'object') {
          for (const dataId of Object.keys(data)) payload.push({ auth_id: authId, daten_id: dataId });
        } else {
          payload.push({ auth_id: authId });
        }
      }
      await this.legacyApi<void>('churchauth/ajax', 'saveAuth', {
        domain_type: 'groupMemberstatus',
        domain_id: domainId,
        data: JSON.stringify(payload)
      }, true);
      changedRoles++;
    }
    return { attempted: true, changedRoles };
  }

  async renderMessage(template: string, personId: number, groupId: number, userId: number): Promise<string> {
    const preview = await churchtoolsClient.post<{ html: string }>('/emails/preview', {
      content: [templateToHtml(template)],
      personId,
      groupId,
      userId
    });
    return htmlToPlainText(preview.html);
  }

  async ownLoginToken(userId: number): Promise<string> {
    const response = await churchtoolsClient.get<LoginTokenResponse>(`/persons/${userId}/logintoken`);
    return loginTokenFromResponse(response);
  }

  static roleId(role: GroupRole): number {
    return roleId(role);
  }
}
