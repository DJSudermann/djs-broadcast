import { churchtoolsClient } from '@churchtools/churchtools-client';
import type { BroadcastConfiguration, StoredBroadcastConfiguration } from './types';

interface CustomModule {
  id: number;
  shorty: string;
}

interface CustomDataCategory {
  id: number;
  customModuleId: number;
  name: string;
  shorty: string;
  description: string;
  data?: string;
}

interface CustomDataValue {
  id: number;
  dataCategoryId: number;
  value: string;
}

const CATEGORY_SHORTY = 'broadcast-configuration';

export class ConfigurationAccessError extends Error {
  constructor() {
    super('Broadcast wurde bereits eingerichtet, aber die gespeicherte Konfiguration ist für dein Konto nicht lesbar. Bitte wende dich an einen Broadcast-Admin.');
    this.name = 'ConfigurationAccessError';
  }
}

function validIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(Number.isSafeInteger))];
}

export function normalizeConfiguration(value: unknown): BroadcastConfiguration | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<BroadcastConfiguration>;
  const adminGroupId = Number(candidate.adminGroupId);
  const updatedBy = Number(candidate.updatedBy);
  if (!Number.isSafeInteger(adminGroupId) || !Number.isSafeInteger(updatedBy)) return null;
  const adminRoleIds = validIds(candidate.adminRoleIds);
  if (!adminRoleIds.length) return null;
  const allowedGroups = Array.isArray(candidate.allowedGroups)
    ? candidate.allowedGroups
        .map(item => ({ groupId: Number(item?.groupId), roleIds: validIds(item?.roleIds) }))
        .filter(item => Number.isSafeInteger(item.groupId) && item.roleIds.length > 0)
    : [];
  return {
    version: 1,
    adminGroupId,
    adminRoleIds,
    allowedGroups,
    analyticsPersonIds: validIds(candidate.analyticsPersonIds),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
    updatedBy
  };
}

export class ConfigurationStore {
  private module: CustomModule | null = null;

  private async getModule(): Promise<CustomModule> {
    if (this.module) return this.module;
    const key = 'djs-broadcast';
    const modules = await churchtoolsClient.get<CustomModule[]>('/custommodules');
    const module = modules.find(item => item.shorty === key);
    if (!module) throw new Error(`Das installierte Broadcast-Modul „${key}“ wurde in ChurchTools nicht gefunden.`);
    this.module = module;
    return module;
  }

  private async categories(moduleId: number): Promise<CustomDataCategory[]> {
    return churchtoolsClient.get<CustomDataCategory[]>(`/custommodules/${moduleId}/customdatacategories`);
  }

  async load(): Promise<StoredBroadcastConfiguration | null> {
    const module = await this.getModule();
    const category = (await this.categories(module.id)).find(item => item.shorty === CATEGORY_SHORTY);
    if (!category) return null;
    let categoryConfig: BroadcastConfiguration | null = null;
    let embeddedValueId = 0;
    if (category.data) {
      try {
        const parsed = JSON.parse(category.data) as Record<string, unknown>;
        categoryConfig = normalizeConfiguration(parsed);
        const parsedValueId = Number(parsed.valueId);
        if (Number.isSafeInteger(parsedValueId) && parsedValueId > 0) embeddedValueId = parsedValueId;
      } catch {
        // Der bisherige Datenwert bleibt die kompatible Rückfallquelle.
      }
    }
    let values: CustomDataValue[] = [];
    try {
      values = await churchtoolsClient.get<CustomDataValue[]>(
        `/custommodules/${module.id}/customdatacategories/${category.id}/customdatavalues`
      );
    } catch {
      // Nutzer mit reinem Leserecht können die Konfiguration aus category.data beziehen.
    }
    for (const stored of values) {
      try {
        const config = normalizeConfiguration(JSON.parse(stored.value));
        if (config) {
          return { ...config, moduleId: module.id, categoryId: category.id, valueId: stored.id };
        }
      } catch {
        // Ungültige oder alte Werte werden ignoriert; der nächste gültige Wert gewinnt.
      }
    }
    if (categoryConfig) {
      return { ...categoryConfig, moduleId: module.id, categoryId: category.id, valueId: embeddedValueId };
    }
    throw new ConfigurationAccessError();
  }

  async create(config: BroadcastConfiguration): Promise<StoredBroadcastConfiguration> {
    const existing = await this.load();
    if (existing) throw new Error('Das Broadcast-Modul wurde inzwischen bereits eingerichtet. Bitte lade die Seite neu.');
    const module = await this.getModule();
    let category = (await this.categories(module.id)).find(item => item.shorty === CATEGORY_SHORTY);
    if (!category) {
      category = await churchtoolsClient.post<CustomDataCategory>(
        `/custommodules/${module.id}/customdatacategories`,
        {
          customModuleId: module.id,
          name: 'Broadcast-Konfiguration',
          shorty: CATEGORY_SHORTY,
          description: 'Admin-, Gruppen-, Rollen- und Analytics-Freigaben des Broadcast-Moduls'
        }
      );
    }
    const stored = await churchtoolsClient.post<CustomDataValue>(
      `/custommodules/${module.id}/customdatacategories/${category.id}/customdatavalues`,
      { dataCategoryId: category.id, value: JSON.stringify(config) }
    );
    return { ...config, moduleId: module.id, categoryId: category.id, valueId: stored.id };
  }

  async save(config: StoredBroadcastConfiguration): Promise<StoredBroadcastConfiguration> {
    const normalized = normalizeConfiguration(config);
    if (!normalized) throw new Error('Die Broadcast-Konfiguration ist ungültig.');
    let valueId = config.valueId;
    if (valueId > 0) {
      await churchtoolsClient.put(
        `/custommodules/${config.moduleId}/customdatacategories/${config.categoryId}/customdatavalues/${valueId}`,
        { dataCategoryId: config.categoryId, value: JSON.stringify(normalized) }
      );
    } else {
      const stored = await churchtoolsClient.post<CustomDataValue>(
        `/custommodules/${config.moduleId}/customdatacategories/${config.categoryId}/customdatavalues`,
        { dataCategoryId: config.categoryId, value: JSON.stringify(normalized) }
      );
      valueId = stored.id;
    }
    return { ...normalized, moduleId: config.moduleId, categoryId: config.categoryId, valueId };
  }
}
