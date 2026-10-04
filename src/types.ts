export interface Person {
  id: number;
  guid: string;
  firstName?: string;
  lastName?: string;
  cmsUserId?: string;
  canChat?: boolean;
  chatActive?: boolean;
}

export interface DomainReference {
  domainIdentifier: string;
  title: string;
  imageUrl?: string | null;
  domainAttributes?: {
    guid?: string | null;
    firstName?: string;
    lastName?: string;
    isArchived?: boolean;
  };
}

export interface Membership {
  id: number;
  groupMemberStatus: 'active' | 'requested' | 'waiting' | 'to_delete';
  groupTypeRoleId: number;
  group: DomainReference;
  person?: DomainReference;
  personId?: number;
}

export interface BroadcastGroupAccess {
  groupId: number;
  roleIds: number[];
}

export interface BroadcastConfiguration {
  version: 1;
  adminGroupId: number;
  adminRoleIds: number[];
  allowedGroups: BroadcastGroupAccess[];
  analyticsPersonIds: number[];
  updatedAt: string;
  updatedBy: number;
}

export interface StoredBroadcastConfiguration extends BroadcastConfiguration {
  moduleId: number;
  categoryId: number;
  valueId: number;
}

export interface GroupRole {
  id: number;
  groupTypeRoleId?: number;
  name?: string;
  nameTranslated?: string;
  type?: 'leader' | 'participant';
  canReadChat?: boolean;
  canWriteChat?: boolean;
  isActive?: boolean;
}

export interface Group {
  id: number;
  guid: string;
  name: string;
  roles?: GroupRole[];
  information?: {
    color?: string;
    chatStatus?: 'NOT_STARTED' | 'STARTING' | 'STARTED' | 'STOPPED';
    imageUrl?: string | null;
  };
}

export interface WritableGroup {
  id: number;
  guid: string;
  name: string;
  color: string;
  chatStatus?: string;
  roles: GroupRole[];
}

export interface Recipient {
  id: number;
  guid: string;
  name: string;
  firstName: string;
  lastName: string;
  roleId: number;
}

export interface PlaceholderItem {
  name?: string;
  label?: string;
  menuLabel?: string;
  title?: string;
  placeholder?: string;
  items?: PlaceholderItem[];
  children?: PlaceholderItem[];
  [key: string]: unknown;
}

export interface PlaceholderOption {
  label: string;
  path: string;
  placeholder: string;
}

export interface SendResult {
  recipient: Recipient;
  status: 'sent' | 'failed';
  error?: string;
}

export interface PermissionSyncResult {
  attempted: boolean;
  changedRoles: number;
  warning?: string;
}
