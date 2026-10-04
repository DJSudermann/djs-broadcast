import { churchtoolsClient } from '@churchtools/churchtools-client';
import { ChurchToolsService, selectedAnalyticsRecipients } from './churchtools';
import { ConfigurationAccessError, ConfigurationStore } from './config';
import { MatrixClient, MatrixError } from './matrix';
import { escapeHtml, flattenPlaceholders, mergePlaceholders, STANDARD_PLACEHOLDERS, validateTemplate } from './template';
import { installChurchToolsThemeSync } from './theme';
import type { BroadcastConfiguration, Person, PlaceholderOption, Recipient, SendResult, StoredBroadcastConfiguration, WritableGroup } from './types';
import './style.css';

const removeThemeSync = installChurchToolsThemeSync();

const baseUrl = window.settings?.base_url;
if (!baseUrl) throw new Error('ChurchTools base_url fehlt.');
churchtoolsClient.setBaseUrl(baseUrl);
const MAX_RECIPIENTS = 200;
const SEND_CONCURRENCY = 3;
const ct = new ChurchToolsService();
const configurationStore = new ConfigurationStore();
const rootElement = document.querySelector<HTMLDivElement>('#app');
if (!rootElement) throw new Error('#app fehlt.');
const root = rootElement;
type View = 'setup' | 'broadcast' | 'admin' | 'denied';
type SetupGroup = WritableGroup & { currentRoleId: number };

interface State {
  view: View; user: Person | null; config: StoredBroadcastConfiguration | null; draftConfig: StoredBroadcastConfiguration | null;
  isAdmin: boolean; groups: WritableGroup[]; group: WritableGroup | null; recipientRoleIds: Set<number>; recipients: Recipient[];
  placeholders: PlaceholderOption[]; template: string; preview: string; connected: boolean; needsPassword: boolean;
  initializing: boolean; loadingRecipients: boolean; connecting: boolean;
  sending: boolean; progress: number; results: SendResult[] | null; error: string; notice: string;
  setupGroups: SetupGroup[]; setupGroupId: number | null; setupRoleIds: Set<number>; adminGroups: WritableGroup[];
  analyticsMembers: Recipient[]; adminGroupQuery: string; loadingAdmin: boolean; savingConfig: boolean;
}

const state: State = {
  view: 'broadcast', user: null, config: null, draftConfig: null, isAdmin: false, groups: [], group: null,
  recipientRoleIds: new Set(), recipients: [], placeholders: STANDARD_PLACEHOLDERS,
  template: 'Hallo {{person.firstName}},\n\nich möchte dir kurz folgende Information für {{group.name}} weitergeben:\n\n',
  preview: '', connected: false, needsPassword: false, initializing: true, loadingRecipients: false, connecting: false,
  sending: false, progress: 0, results: null, error: '', notice: '',
  setupGroups: [], setupGroupId: null, setupRoleIds: new Set(), adminGroups: [], analyticsMembers: [], adminGroupQuery: '', loadingAdmin: false, savingConfig: false
};
let matrix: MatrixClient | null = null;

function integer(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
async function mapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  async function worker(): Promise<void> { while (next < items.length) { const index = next++; const item = items[index]; if (item !== undefined) results[index] = await mapper(item); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)); return results;
}
function matrixUserId(guid: string, matrixBaseUrl: string): string { return `@ct_${guid.toLowerCase()}:${new URL(matrixBaseUrl).hostname}`; }
function messageFromError(error: unknown): string {
  if (error instanceof MatrixError && error.status === 401) return 'Die Chat-Anmeldung wurde abgelehnt.';
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
    const data = response?.data;
    const details = data && typeof data === 'object'
      ? data as { status?: unknown; message?: unknown; translatedMessage?: unknown; error?: unknown; data?: unknown }
      : null;
    const nested = details?.data && typeof details.data === 'object'
      ? details.data as { message?: unknown; error?: unknown }
      : null;
    const serverMessage = details?.translatedMessage || details?.message || details?.error ||
      (typeof details?.data === 'string' ? details.data : null) || nested?.message || nested?.error;
    const status = Number(response?.status);
    if (typeof serverMessage === 'string' && serverMessage.trim()) {
      return `${serverMessage}${Number.isSafeInteger(status) ? ` (HTTP ${status})` : ''}`;
    }
    if (typeof details?.status === 'string' && details.status.trim()) {
      return `ChurchTools-Legacy-Status „${details.status}“${Number.isSafeInteger(status) ? ` (HTTP ${status})` : ''}.`;
    }
    if (typeof data === 'string') {
      const responseKind = data.trimStart().startsWith('<') ? 'HTML' : 'Text';
      const excerpt = data.trim().slice(0, 180).replace(/[A-Za-z0-9_-]{24,}/g, '[MASKIERT]');
      return `ChurchTools lieferte beim Legacy-Aufruf eine unerwartete ${responseKind}-Antwort${Number.isSafeInteger(status) ? ` (HTTP ${status})` : ''}${excerpt ? `: ${excerpt}` : ' ohne Inhalt'}.`;
    }
    if (Number.isSafeInteger(status)) return `ChurchTools-Anfrage fehlgeschlagen (HTTP ${status}).`;
  }
  return 'Ein unerwarteter Fehler ist aufgetreten.';
}
function groupColor(color: string): string { return new Set(['blue','cyan','emerald','green','indigo','orange','pink','purple','red','rose','sky','teal','violet','yellow']).has(color) ? color : 'accent'; }
function roleIdentifier(group: WritableGroup, index: number): number { const role = group.roles[index]; return Number(role?.groupTypeRoleId ?? role?.id); }
function roleLabel(group: WritableGroup, selectedRoleId: number): string {
  const role = group.roles.find((_, index) => roleIdentifier(group, index) === selectedRoleId);
  return role?.nameTranslated || role?.name || `Rolle ${selectedRoleId}`;
}
function selectableRecipientRoles(group: WritableGroup): Array<{ id: number; label: string }> {
  const roles = group.roles.map((role, index) => ({
    id: roleIdentifier(group, index),
    label: role.nameTranslated || role.name || `Rolle ${roleIdentifier(group, index)}`,
    chatEnabled: role.canReadChat === true || role.canWriteChat === true
  }));
  const chatRoles = roles.filter(role => role.chatEnabled);
  return (chatRoles.length ? chatRoles : roles).map(({ id, label }) => ({ id, label }));
}
function personName(person: Person | null): string { return [person?.firstName, person?.lastName].filter(Boolean).join(' ') || `Person ${person?.id || ''}`; }
function updateTemplateFromDom(): void { const textarea = document.querySelector<HTMLTextAreaElement>('#message'); if (textarea) state.template = textarea.value; }

function shell(content: string): string {
  return `<main class="broadcast-shell"><header class="hero compact-hero"><div><h1>Persönlich schreiben.<br><span>Alle erreichen.</span></h1><p>Versende individuelle Privatnachrichten an die Mitglieder freigegebener Gruppen – direkt in deinem Namen.</p></div><div class="header-actions">${state.isAdmin && state.view !== 'admin' ? '<button id="open-admin" class="button secondary">Admin-Bereich</button>' : ''}${state.view === 'admin' ? '<button id="back-broadcast" class="button secondary">← Broadcast</button>' : ''}<div class="identity-card"><div class="avatar">${escapeHtml((state.user?.firstName?.[0] || '') + (state.user?.lastName?.[0] || ''))}</div><div><span>Angemeldet als</span><strong>${escapeHtml(personName(state.user))}</strong></div></div></div></header>
  ${state.error ? `<div class="alert" role="alert"><span>!</span><div>${escapeHtml(state.error)}</div><button id="dismiss-error" class="alert-dismiss" aria-label="Fehler schließen">×</button></div>` : ''}
  ${state.notice ? `<div class="notice" role="status"><span>✓</span><div>${escapeHtml(state.notice)}</div><button id="dismiss-notice" aria-label="Hinweis schließen">×</button></div>` : ''}${content}</main>`;
}

function render(): void {
  if (state.initializing) { root.innerHTML = '<main class="broadcast-shell"><div class="loading-card"><span class="spinner"></span><h1>Broadcast wird vorbereitet</h1><p>Konfiguration und Berechtigungen werden geladen …</p></div></main>'; return; }
  root.innerHTML = shell(state.view === 'setup' ? renderSetup() : state.view === 'admin' ? renderAdmin() : state.view === 'denied' ? renderDenied() : renderBroadcast());
  bindCommonEvents(); if (state.view === 'setup') bindSetupEvents(); else if (state.view === 'admin') bindAdminEvents(); else if (state.view === 'broadcast') bindBroadcastEvents();
}

function renderSetup(): string {
  const selected = state.setupGroups.find(group => group.id === state.setupGroupId);
  return `<section class="panel setup-panel"><div class="setup-intro"><span class="setup-badge">Ersteinrichtung</span><h2>Wer verwaltet Broadcast?</h2><p>Wähle eine Gruppe und die darin enthaltenen Rollen aus, die später Gruppen und Rollen für Broadcast freigeben dürfen. Mindestens deine eigene aktuelle Rolle muss enthalten sein.</p></div><div class="setup-form"><label class="field-label" for="setup-group">Admin-Gruppe</label><select id="setup-group"><option value="">Gruppe auswählen …</option>${state.setupGroups.map(group => `<option value="${group.id}" ${group.id === state.setupGroupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}</select>${selected ? `<h3 class="field-label">Verantwortliche Rollen</h3><div class="role-grid">${selected.roles.map((role, index) => { const id = roleIdentifier(selected, index); return `<label class="check-pill"><input type="checkbox" data-setup-role="${id}" ${state.setupRoleIds.has(id) ? 'checked' : ''}><span class="check-box">✓</span><span>${escapeHtml(role.nameTranslated || role.name || `Rolle ${id}`)}</span></label>`; }).join('')}</div><p class="setup-current-role">Deine aktuelle Rolle ist markiert und muss ausgewählt bleiben.</p>` : ''}<div class="setup-actions"><button id="save-setup" class="button primary" ${!selected || !state.setupRoleIds.size || state.savingConfig ? 'disabled' : ''}>${state.savingConfig ? 'Einrichtung wird gespeichert …' : 'Einrichtung abschließen'}</button></div></div></section>`;
}

function renderDenied(): string {
  return `<section class="panel access-denied"><span class="access-icon">×</span><h2>Broadcast ist für deine Rolle nicht freigegeben</h2><p>Du musst aktives Mitglied einer freigegebenen Gruppe sein, dort eine freigegebene Rolle besitzen und im Gruppenchat schreiben dürfen.</p>${state.isAdmin ? '<button id="denied-open-admin" class="button primary">Admin-Bereich öffnen</button>' : ''}</section>`;
}

function renderAdmin(): string {
  if (state.loadingAdmin || !state.draftConfig) return '<section class="panel"><div class="loading-card admin-loading"><span class="spinner"></span><h1>Admin-Bereich wird geladen</h1><p>Sichtbare Gruppen, Rollen und Personen werden abgerufen …</p></div></section>';
  const config = state.draftConfig; const adminGroup = state.adminGroups.find(group => group.id === config.adminGroupId); const selectedAnalytics = new Set(config.analyticsPersonIds); const normalizedGroupQuery = state.adminGroupQuery.trim().toLocaleLowerCase('de');
  const savedGrants = (state.config?.allowedGroups || []).filter(access => access.roleIds.length).map(access => { const group = state.adminGroups.find(item => item.id === access.groupId); return `<li><strong>${escapeHtml(group?.name || `Gruppe ${access.groupId}`)}</strong><span>${escapeHtml(access.roleIds.map(id => group ? roleLabel(group, id) : `Rolle ${id}`).join(', '))}</span></li>`; }).join('');
  return `<section class="admin-layout"><aside class="admin-sidebar"><div class="panel admin-summary"><div class="panel-heading"><div><span class="step">A</span><h2>Administration</h2></div></div><div class="admin-summary-body"><label class="field-label" for="admin-owner-group">Verantwortliche Admin-Gruppe</label><select id="admin-owner-group">${state.adminGroups.map(group => `<option value="${group.id}" ${group.id === config.adminGroupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}</select>${adminGroup ? `<label class="field-label">Verantwortliche Rollen</label><div class="admin-role-list">${adminGroup.roles.map((role, index) => { const id = roleIdentifier(adminGroup, index); return `<label class="check-pill"><input type="checkbox" data-admin-role="${id}" ${config.adminRoleIds.includes(id) ? 'checked' : ''}><span class="check-box">✓</span><span>${escapeHtml(role.nameTranslated || role.name || `Rolle ${id}`)}</span></label>`; }).join('')}</div>` : ''}<p>Admin-Gruppe und Rollen können hier korrigiert oder an eine geänderte Gruppenstruktur angepasst werden. Beim Speichern werden die ChurchTools-Rechte entsprechend übertragen.</p></div></div><div class="panel grants-summary"><div class="panel-heading"><div><span class="step">✓</span><h2>Bisherige Freigaben</h2></div></div>${savedGrants ? `<ul>${savedGrants}</ul>` : '<p>Noch keine Broadcast-Gruppe freigegeben.</p>'}</div></aside>
  <div class="panel admin-config"><div class="panel-heading"><div><span class="step">1</span><h2>Broadcast-Freigaben</h2></div><span id="allowed-group-count" class="count strong">${config.allowedGroups.filter(item => item.roleIds.length).length}</span></div><p class="admin-description">Eine Person darf eine Gruppe nur verwenden, wenn sie dort eine ausgewählte Rolle und zusätzlich Chat-Schreibrecht besitzt. Empfänger sind immer alle aktiven, chatfähigen Rollen der Gruppe.</p><div class="admin-group-search"><input id="admin-group-search" type="search" value="${escapeHtml(state.adminGroupQuery)}" placeholder="Gruppen suchen …" aria-label="Gruppen suchen"></div><div class="permission-groups">${state.adminGroups.map(group => { const access = config.allowedGroups.find(item => item.groupId === group.id); const searchText = group.name.toLocaleLowerCase('de'); const hidden = normalizedGroupQuery && !searchText.includes(normalizedGroupQuery); return `<article class="permission-group ${access ? 'enabled' : ''}" data-admin-group-search="${escapeHtml(searchText)}" ${hidden ? 'hidden' : ''}><label class="permission-group-title"><input type="checkbox" data-allow-group="${group.id}" ${access ? 'checked' : ''}><span class="group-mark color-${groupColor(group.color)}">${escapeHtml(group.name.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(group.name)}</strong><small>${access ? `${access.roleIds.length} Rolle(n) freigegeben` : 'Nicht freigegeben'}</small></span></label>${access ? `<div class="role-grid">${group.roles.map((role, index) => { const id = roleIdentifier(group, index); return `<label class="check-pill"><input type="checkbox" data-allow-role="${group.id}:${id}" ${access.roleIds.includes(id) ? 'checked' : ''}><span class="check-box">✓</span><span>${escapeHtml(role.nameTranslated || role.name || `Rolle ${id}`)}</span></label>`; }).join('')}</div>` : ''}</article>`; }).join('')}<p id="admin-group-no-results" class="no-placeholders" ${state.adminGroups.some(group => group.name.toLocaleLowerCase('de').includes(normalizedGroupQuery)) ? 'hidden' : ''}>Keine Gruppen gefunden.</p></div></div>
  <div class="panel admin-config"><div class="panel-heading"><div><span class="step">2</span><h2>Analytics-Admins</h2></div><span class="count">${selectedAnalytics.size}</span></div><div class="analytics-grid">${state.analyticsMembers.length ? state.analyticsMembers.map(person => `<label class="person-check"><input type="checkbox" data-analytics-person="${person.id}" ${selectedAnalytics.has(person.id) ? 'checked' : ''}><span class="avatar small">${escapeHtml((person.firstName[0] || '') + (person.lastName[0] || ''))}</span><span>${escapeHtml(person.name)}</span></label>`).join('') : '<p class="no-placeholders">Keine aktiven Personen mit Chat-Zugang gefunden.</p>'}</div><div class="admin-save"><button id="save-admin" class="button primary" ${state.savingConfig || !config.adminRoleIds.length ? 'disabled' : ''}>${state.savingConfig ? 'Freigaben werden gespeichert …' : 'Konfiguration speichern'}</button></div></div></section>`;
}

function renderBroadcast(): string {
  const selectedGroup = state.group; const recipientRoles = selectedGroup ? selectableRecipientRoles(selectedGroup) : []; const sent = state.results?.filter(result => result.status === 'sent').length || 0; const failed = state.results?.filter(result => result.status === 'failed').length || 0;
  return `<section class="workspace-grid"><aside class="panel groups-panel"><div class="panel-heading"><div><span class="step">1</span><h2>Gruppe wählen</h2></div><span class="count">${state.groups.length}</span></div><p class="hint">Nur freigegebene Gruppen, in denen deine aktuelle Rolle freigegeben ist und du im Chat schreiben darfst.</p><div class="group-list">${state.groups.length ? state.groups.map(group => `<button class="group-card ${selectedGroup?.id === group.id ? 'active' : ''}" data-group-id="${group.id}" ${state.loadingRecipients ? 'disabled' : ''}><span class="group-mark color-${groupColor(group.color)}">${escapeHtml(group.name.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(group.name)}</strong><small>${group.roles.length} Rollen</small></span><span class="chevron">›</span></button>`).join('') : '<div class="empty-state"><strong>Keine freigegebene Gruppe</strong><p>Für deine aktuellen Gruppenrollen ist keine Gruppe mit Chat-Schreibrecht verfügbar.</p></div>'}</div></aside>
  <section class="compose-column"><div class="panel"><div class="panel-heading"><div><span class="step">2</span><h2>Empfänger</h2></div>${selectedGroup ? `<span class="count strong">${state.recipients.length}</span>` : ''}</div>${selectedGroup ? `<div class="selected-group"><span class="group-mark color-${groupColor(selectedGroup.color)}">${escapeHtml(selectedGroup.name.slice(0, 2).toUpperCase())}</span><div><small>Ausgewählte Gruppe</small><strong>${escapeHtml(selectedGroup.name)}</strong></div></div><div class="recipient-role-section"><label class="field-label">Empfängerrollen</label><div class="role-grid">${recipientRoles.map(role => `<label class="check-pill"><input type="checkbox" data-recipient-role="${role.id}" ${state.recipientRoleIds.has(role.id) ? 'checked' : ''} ${state.loadingRecipients ? 'disabled' : ''}><span class="check-box">✓</span><span>${escapeHtml(role.label)}</span></label>`).join('')}</div></div><div class="recipient-strip"><div class="face-stack">${state.loadingRecipients ? '<span class="mini-spinner" aria-hidden="true"></span>' : state.recipients.slice(0, 5).map(recipient => `<span title="${escapeHtml(recipient.name)}">${escapeHtml((recipient.firstName[0] || '') + (recipient.lastName[0] || ''))}</span>`).join('')}</div><div><strong>${state.loadingRecipients ? 'Empfänger werden aktualisiert …' : `${state.recipients.length} erreichbare ${state.recipients.length === 1 ? 'Person' : 'Personen'}`}</strong><small>Aktive Mitglieder der ausgewählten Rollen mit Chat-Zugang</small></div></div>` : '<div class="empty-compose"><span>←</span><p>Wähle zuerst eine Gruppe aus.</p></div>'}</div>
  <div class="panel composer ${selectedGroup ? '' : 'disabled'}"><div class="panel-heading"><div><span class="step">3</span><h2>Nachricht verfassen</h2></div><span class="char-count">${state.template.length} / 5000</span></div><div class="editor-grid"><div><label class="field-label" for="message">Nachricht</label><textarea id="message" maxlength="5000" ${selectedGroup ? '' : 'disabled'}>${escapeHtml(state.template)}</textarea><div class="editor-actions"><button id="preview-button" class="button secondary" ${!selectedGroup || !state.recipients.length || state.loadingRecipients ? 'disabled' : ''}>Vorschau anzeigen</button><small>Platzhalter werden für jede Person einzeln ersetzt.</small></div></div><aside class="placeholder-panel"><div class="placeholder-title"><strong>Platzhalter</strong><span>${state.placeholders.length}</span></div><input id="placeholder-search" type="search" placeholder="Platzhalter suchen …" aria-label="Platzhalter suchen"><div id="placeholder-list" class="placeholder-list">${renderPlaceholders(state.placeholders)}</div></aside></div></div>
  ${state.results ? `<div class="panel results"><div class="result-summary"><span class="result-icon">✓</span><div><h2>Versand abgeschlossen</h2><p>${sent} gesendet${failed ? ` · ${failed} fehlgeschlagen` : ''}</p></div></div>${failed ? `<details><summary>Fehler anzeigen</summary><ul>${state.results.filter(result => result.status === 'failed').map(result => `<li><strong>${escapeHtml(result.recipient.name)}</strong>: ${escapeHtml(result.error || 'Unbekannter Fehler')}</li>`).join('')}</ul></details>` : ''}</div>` : ''}
  ${state.needsPassword && !state.connected ? `<div class="panel chat-auth-panel"><form id="password-form" class="password-form"><label for="chat-password">Chat-Anmeldung bestätigen</label><div><input id="chat-password" type="password" autocomplete="current-password" required placeholder="ChurchTools-Passwort" ${state.connecting ? 'disabled' : ''}><button class="button secondary" type="submit" ${state.connecting ? 'disabled' : ''}>${state.connecting ? 'Verbindet …' : 'Anmelden'}</button></div><small>Das Passwort wird nicht gespeichert.</small></form></div>` : ''}
  ${state.preview ? `<section class="panel send-confirmation"><div class="dialog-header"><span class="dialog-icon">↗</span><div><h2>Broadcast jetzt senden?</h2><p>Bitte prüfe Empfänger und Nachricht ein letztes Mal.</p></div></div><div class="dialog-facts"><div><span>Empfänger</span><strong>${state.recipients.length} private ${state.recipients.length === 1 ? 'Nachricht' : 'Nachrichten'}</strong></div><div><span>Gruppe</span><strong>${escapeHtml(selectedGroup?.name || '')}</strong></div></div><div class="dialog-message"><div><strong>Nachrichtenvorschau</strong><span>Beispiel für ${escapeHtml(state.recipients[0]?.name || 'die erste Person')}</span></div><pre>${escapeHtml(state.preview)}</pre><small>Platzhalter werden für alle weiteren Empfänger individuell ersetzt.</small></div><div class="dialog-warning">Der Versand lässt sich anschließend nicht zurückrufen.</div><div class="dialog-actions"><button id="cancel-send" class="button secondary" ${state.sending ? 'disabled' : ''}>Abbrechen</button><button id="send-button" class="button primary" ${!state.connected || state.connecting || state.sending ? 'disabled' : ''}>${state.sending ? `Versende ${state.progress}/${state.recipients.length} …` : state.connecting ? 'Chat wird verbunden …' : 'Jetzt senden'}</button></div>${state.sending ? `<div class="progress"><span style="width:${Math.round((state.progress / Math.max(state.recipients.length, 1)) * 100)}%"></span></div>` : ''}</section>` : ''}</section></section>`;
}

function renderPlaceholders(placeholders: PlaceholderOption[], query = ''): string {
  const normalized = query.trim().toLocaleLowerCase('de'); const filtered = placeholders.filter(item => `${item.label} ${item.path} ${item.placeholder}`.toLocaleLowerCase('de').includes(normalized));
  return filtered.length ? filtered.map(item => `<button data-placeholder="${escapeHtml(item.placeholder)}"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.path || item.placeholder)}</small></button>`).join('') : '<p class="no-placeholders">Keine Treffer</p>';
}

function bindCommonEvents(): void {
  document.querySelector('#dismiss-error')?.addEventListener('click', () => { state.error = ''; render(); });
  document.querySelector('#dismiss-notice')?.addEventListener('click', () => { state.notice = ''; render(); });
  document.querySelector('#open-admin')?.addEventListener('click', () => void openAdmin()); document.querySelector('#denied-open-admin')?.addEventListener('click', () => void openAdmin());
  document.querySelector('#back-broadcast')?.addEventListener('click', () => { state.view = state.groups.length || state.isAdmin ? 'broadcast' : 'denied'; state.error = ''; render(); if (state.groups.length && !state.connected && !state.connecting && !state.needsPassword) void connectChat(); });
}

function bindSetupEvents(): void {
  document.querySelector<HTMLSelectElement>('#setup-group')?.addEventListener('change', event => { const id = Number((event.currentTarget as HTMLSelectElement).value); const group = state.setupGroups.find(item => item.id === id); state.setupGroupId = group?.id || null; state.setupRoleIds = new Set(group ? [group.currentRoleId] : []); render(); });
  document.querySelectorAll<HTMLInputElement>('[data-setup-role]').forEach(input => input.addEventListener('change', () => { const roleId = Number(input.dataset.setupRole); const group = state.setupGroups.find(item => item.id === state.setupGroupId); if (!group) return; if (!input.checked && roleId === group.currentRoleId) { input.checked = true; state.error = 'Deine aktuelle Rolle muss als Admin-Rolle ausgewählt bleiben.'; render(); return; } if (input.checked) state.setupRoleIds.add(roleId); else state.setupRoleIds.delete(roleId); }));
  document.querySelector('#save-setup')?.addEventListener('click', () => void saveSetup());
}

function bindAdminEvents(): void {
  document.querySelector<HTMLSelectElement>('#admin-owner-group')?.addEventListener('change', event => {
    void changeAdminGroup(Number((event.currentTarget as HTMLSelectElement).value));
  });
  document.querySelectorAll<HTMLInputElement>('[data-admin-role]').forEach(input => input.addEventListener('change', () => {
    if (!state.draftConfig) return;
    const roleId = Number(input.dataset.adminRole);
    const roles = new Set(state.draftConfig.adminRoleIds);
    input.checked ? roles.add(roleId) : roles.delete(roleId);
    state.draftConfig.adminRoleIds = [...roles];
    const save = document.querySelector<HTMLButtonElement>('#save-admin');
    if (save) save.disabled = state.savingConfig || roles.size === 0;
  }));
  const search = document.querySelector<HTMLInputElement>('#admin-group-search');
  search?.addEventListener('input', () => {
    state.adminGroupQuery = search.value;
    const query = search.value.trim().toLocaleLowerCase('de');
    let visible = 0;
    document.querySelectorAll<HTMLElement>('[data-admin-group-search]').forEach(group => {
      group.hidden = Boolean(query) && !(group.dataset.adminGroupSearch || '').includes(query);
      if (!group.hidden) visible++;
    });
    const empty = document.querySelector<HTMLElement>('#admin-group-no-results');
    if (empty) empty.hidden = visible > 0;
  });
  document.querySelectorAll<HTMLInputElement>('[data-allow-group]').forEach(input => input.addEventListener('change', () => { const groupId = Number(input.dataset.allowGroup); const group = state.adminGroups.find(item => item.id === groupId); if (!state.draftConfig || !group) return; state.draftConfig.allowedGroups = state.draftConfig.allowedGroups.filter(item => item.groupId !== groupId); if (input.checked) state.draftConfig.allowedGroups.push({ groupId, roleIds: group.roles.map((_, index) => roleIdentifier(group, index)) }); renderAdminPreservingScroll(); }));
  document.querySelectorAll<HTMLInputElement>('[data-allow-role]').forEach(input => {
    let scrollSnapshot = captureAdminScroll();
    let pointerInteraction = false;
    input.closest<HTMLElement>('.check-pill')?.addEventListener('pointerdown', () => { pointerInteraction = true; scrollSnapshot = captureAdminScroll(); }, { capture: true });
    input.addEventListener('keydown', () => { pointerInteraction = false; scrollSnapshot = captureAdminScroll(); }, { capture: true });
    input.addEventListener('change', () => {
      if (!state.draftConfig) return;
      const parts = (input.dataset.allowRole || '').split(':').map(Number);
      const groupId = parts[0];
      const roleId = parts[1];
      if (!Number.isSafeInteger(groupId) || !Number.isSafeInteger(roleId)) return;
      const access = state.draftConfig.allowedGroups.find(item => item.groupId === groupId);
      if (!access) return;
      if (input.checked && !access.roleIds.includes(roleId as number)) access.roleIds.push(roleId as number);
      else if (!input.checked) access.roleIds = access.roleIds.filter(id => id !== roleId);
      const article = input.closest<HTMLElement>('.permission-group');
      const summary = article?.querySelector<HTMLElement>('.permission-group-title small');
      if (summary) summary.textContent = `${access.roleIds.length} Rolle(n) freigegeben`;
      const count = document.querySelector<HTMLElement>('#allowed-group-count');
      if (count) count.textContent = String(state.draftConfig.allowedGroups.filter(item => item.roleIds.length).length);
      if (pointerInteraction) input.blur();
      restoreAdminScroll(scrollSnapshot);
    });
  });
  document.querySelectorAll<HTMLInputElement>('[data-analytics-person]').forEach(input => input.addEventListener('change', () => { if (!state.draftConfig) return; const id = Number(input.dataset.analyticsPerson); const ids = new Set(state.draftConfig.analyticsPersonIds); input.checked ? ids.add(id) : ids.delete(id); state.draftConfig.analyticsPersonIds = [...ids]; }));
  document.querySelector('#save-admin')?.addEventListener('click', () => void saveAdminConfiguration());
}

async function changeAdminGroup(groupId: number): Promise<void> {
  if (!state.draftConfig || !state.adminGroups.some(group => group.id === groupId)) return;
  const snapshot = captureAdminScroll();
  state.draftConfig.adminGroupId = groupId;
  state.draftConfig.adminRoleIds = [];
  state.draftConfig.analyticsPersonIds = [];
  state.analyticsMembers = [];
  render();
  restoreAdminScroll(snapshot);
  try {
    state.analyticsMembers = await ct.activeChatMembers(groupId);
    state.error = '';
  } catch (error) {
    state.error = `Die Personen der neuen Admin-Gruppe konnten nicht geladen werden: ${messageFromError(error)}`;
  }
  render();
  restoreAdminScroll(snapshot);
}

interface AdminScrollSnapshot { pageX: number; pageY: number; listScrollTop: number }

function captureAdminScroll(): AdminScrollSnapshot {
  return {
    pageX: window.scrollX,
    pageY: window.scrollY,
    listScrollTop: document.querySelector<HTMLElement>('.permission-groups')?.scrollTop || 0
  };
}

function restoreAdminScroll(snapshot: AdminScrollSnapshot): void {
  const restore = () => {
    const list = document.querySelector<HTMLElement>('.permission-groups');
    if (list) list.scrollTop = snapshot.listScrollTop;
    const scrollingElement = document.scrollingElement;
    if (scrollingElement) {
      scrollingElement.scrollLeft = snapshot.pageX;
      scrollingElement.scrollTop = snapshot.pageY;
    } else {
      window.scrollTo(snapshot.pageX, snapshot.pageY);
    }
  };
  restore();
  requestAnimationFrame(() => {
    restore();
    requestAnimationFrame(restore);
  });
  window.setTimeout(restore, 0);
}

function renderAdminPreservingScroll(): void {
  const snapshot = captureAdminScroll();
  render();
  restoreAdminScroll(snapshot);
}

function bindPlaceholderButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-placeholder]').forEach(button => button.addEventListener('click', () => { const textarea = document.querySelector<HTMLTextAreaElement>('#message'); if (!textarea) return; textarea.setRangeText(button.dataset.placeholder || '', textarea.selectionStart, textarea.selectionEnd, 'end'); state.template = textarea.value; textarea.focus(); document.querySelector('.char-count')!.textContent = `${state.template.length} / 5000`; }));
}

function bindBroadcastEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-group-id]').forEach(button => button.addEventListener('click', () => void selectGroup(Number(button.dataset.groupId))));
  document.querySelectorAll<HTMLInputElement>('[data-recipient-role]').forEach(input => input.addEventListener('change', () => {
    const roleId = Number(input.dataset.recipientRole);
    if (input.checked) state.recipientRoleIds.add(roleId); else state.recipientRoleIds.delete(roleId);
    state.preview = ''; state.results = null;
    void refreshRecipientsForSelectedRoles();
  }));
  document.querySelector<HTMLTextAreaElement>('#message')?.addEventListener('input', event => { state.template = (event.currentTarget as HTMLTextAreaElement).value; document.querySelector('.char-count')!.textContent = `${state.template.length} / 5000`; });
  const search = document.querySelector<HTMLInputElement>('#placeholder-search'); search?.addEventListener('input', () => { const list = document.querySelector<HTMLDivElement>('#placeholder-list'); if (list) list.innerHTML = renderPlaceholders(state.placeholders, search.value); bindPlaceholderButtons(); }); bindPlaceholderButtons();
  document.querySelector('#preview-button')?.addEventListener('click', () => void showPreview()); document.querySelector('#cancel-send')?.addEventListener('click', () => { state.preview = ''; render(); });
  document.querySelector<HTMLFormElement>('#password-form')?.addEventListener('submit', event => { event.preventDefault(); const password = document.querySelector<HTMLInputElement>('#chat-password'); if (password?.value) void connectWithSecret(password.value); });
  document.querySelector('#send-button')?.addEventListener('click', () => void sendBroadcast());
}

function setError(message: string): void { updateTemplateFromDom(); state.error = message; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

async function syncPermissionsSafely(previous: BroadcastConfiguration | null, next: BroadcastConfiguration, groups: WritableGroup[]) {
  try {
    return await ct.syncModuleViewPermissions(previous, next, groups);
  }
  catch (error) {
    return { attempted: true, changedRoles: 0, warning: `Die Freigaben wurden gespeichert, aber das native ChurchTools-Anzeigen-Recht konnte nicht automatisch synchronisiert werden: ${messageFromError(error)}` };
  }
}

async function repairAdminConfiguration(config: StoredBroadcastConfiguration): Promise<void> {
  try {
    const permissionGroups = await ct.configuredGroups(config);
    const permissionResult = await syncPermissionsSafely(config, config, permissionGroups);
    state.notice = permissionResult.warning || '';
  } catch (repairError) {
    state.notice = `Die Broadcast-Seite ist geladen; die automatische Berechtigungsprüfung konnte nicht abgeschlossen werden: ${messageFromError(repairError)}`;
  } finally {
    render();
  }
}

async function saveSetup(): Promise<void> {
  const user = state.user; const group = state.setupGroups.find(item => item.id === state.setupGroupId);
  if (!user || !group || !state.setupRoleIds.has(group.currentRoleId)) return setError('Bitte wähle eine Admin-Gruppe und mindestens deine aktuelle Rolle.');
  state.savingConfig = true; state.error = ''; render();
  const config: BroadcastConfiguration = { version: 1, adminGroupId: group.id, adminRoleIds: [...state.setupRoleIds], allowedGroups: [], analyticsPersonIds: [], updatedAt: new Date().toISOString(), updatedBy: user.id };
  try {
    const stored = await configurationStore.create(config); const permissionResult = await syncPermissionsSafely(null, stored, state.setupGroups);
    state.config = stored; state.isAdmin = true; state.notice = permissionResult.warning || 'Die Ersteinrichtung wurde gespeichert. Du kannst jetzt Gruppen und Rollen freigeben.'; state.view = 'admin'; await loadAdminData();
  } catch (error) { state.error = messageFromError(error); }
  finally { state.savingConfig = false; render(); }
}

async function openAdmin(): Promise<void> {
  if (!state.isAdmin || !state.config) return; updateTemplateFromDom(); state.view = 'admin'; state.error = ''; render(); await loadAdminData(); render();
}

async function loadAdminData(): Promise<void> {
  if (!state.config) return; state.loadingAdmin = true;
  try {
    const [groups, analyticsMembers] = await Promise.all([ct.visibleGroups(), ct.activeChatMembers(state.config.adminGroupId)]);
    if (!groups.some(group => group.id === state.config?.adminGroupId)) groups.push(await ct.group(state.config.adminGroupId));
    state.adminGroups = groups.sort((a, b) => a.name.localeCompare(b.name, 'de')); state.analyticsMembers = analyticsMembers; state.draftConfig = structuredClone(state.config);
  } catch (error) { state.error = messageFromError(error); }
  finally { state.loadingAdmin = false; }
}

async function saveAdminConfiguration(): Promise<void> {
  if (!state.config || !state.draftConfig || !state.user) return;
  if (!state.draftConfig.adminRoleIds.length) return setError('Bitte wähle mindestens eine verantwortliche Admin-Rolle aus.');
  const previous = structuredClone(state.config); const next = structuredClone(state.draftConfig); next.allowedGroups = next.allowedGroups.filter(item => item.roleIds.length > 0); next.updatedAt = new Date().toISOString(); next.updatedBy = state.user.id; next.analyticsPersonIds = next.analyticsPersonIds.filter(id => state.analyticsMembers.some(person => person.id === id));
  state.savingConfig = true; state.error = ''; render();
  try {
    state.config = await configurationStore.save(next); const permissionResult = await syncPermissionsSafely(previous, next, state.adminGroups); const access = await ct.configurationAccess(state.user, next); state.groups = access.groups; state.isAdmin = access.isAdmin;
    if (state.group && !state.groups.some(group => group.id === state.group?.id)) { state.group = null; state.recipients = []; }
    state.draftConfig = structuredClone(next); state.notice = permissionResult.warning || `Freigaben gespeichert${permissionResult.changedRoles ? `; das native Anzeigen-Recht wurde für ${permissionResult.changedRoles} Rolle(n) aktualisiert` : ''}.`;
    if (!state.isAdmin) state.view = state.groups.length ? 'broadcast' : 'denied';
  } catch (error) { state.config = previous; state.error = messageFromError(error); }
  finally { state.savingConfig = false; render(); }
}

async function selectGroup(id: number): Promise<void> {
  updateTemplateFromDom(); const group = state.groups.find(item => item.id === id); if (!group || !state.user || !state.config) return;
  if (!state.connected && !state.connecting && !state.needsPassword) void connectChat();
  state.group = group; state.recipientRoleIds = new Set(selectableRecipientRoles(group).map(role => role.id)); state.recipients = []; state.placeholders = STANDARD_PLACEHOLDERS; state.preview = ''; state.results = null; state.error = ''; state.loadingRecipients = true; render();
  try { const [placeholders] = await Promise.all([ct.placeholders(id, state.user.id, state.config), loadRecipients()]); state.placeholders = mergePlaceholders(STANDARD_PLACEHOLDERS, flattenPlaceholders(placeholders)); }
  catch (error) { state.error = messageFromError(error); }
  finally { state.loadingRecipients = false; render(); }
}

async function loadRecipients(): Promise<void> {
  if (!state.group || !state.user || !state.config) return; state.recipients = await ct.recipients(state.group.id, state.user.id, [...state.recipientRoleIds], state.config);
  if (state.recipients.length > MAX_RECIPIENTS) throw new Error(`Die Gruppe enthält ${state.recipients.length} Personen. Maximal erlaubt sind ${MAX_RECIPIENTS}.`); state.preview = '';
}

async function refreshRecipientsForSelectedRoles(): Promise<void> {
  const scrollX = window.scrollX; const scrollY = window.scrollY;
  state.loadingRecipients = true;
  try { await loadRecipients(); state.error = ''; }
  catch (error) { state.recipients = []; state.error = messageFromError(error); }
  finally {
    state.loadingRecipients = false; render();
    requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
  }
}

async function showPreview(): Promise<void> {
  updateTemplateFromDom(); const error = validateTemplate(state.template); const recipient = state.recipients[0]; if (error) return setError(error); if (!state.group || !state.user || !state.config || !recipient) return;
  try { await ct.assertCanBroadcast(state.group.id, state.user.id, state.config); state.preview = await ct.renderMessage(state.template, recipient.id, state.group.id, state.user.id); state.results = null; state.error = ''; render(); }
  catch (previewError) { setError(messageFromError(previewError)); }
}

async function connectChat(): Promise<void> {
  if (!state.user || !matrix) return; updateTemplateFromDom(); state.connecting = true; render();
  try { const loginToken = await ct.ownLoginToken(state.user.id); await matrix.login(loginToken, 'login-token'); state.connected = true; state.needsPassword = false; state.error = ''; }
  catch { state.needsPassword = true; }
  finally { state.connecting = false; render(); }
}

async function connectWithSecret(secret: string): Promise<void> {
  if (!matrix) return; updateTemplateFromDom(); state.connecting = true; render();
  try { await matrix.login(secret, 'password'); state.connected = true; state.needsPassword = false; state.error = ''; }
  catch (error) { state.connected = false; state.needsPassword = true; state.error = messageFromError(error); }
  finally { secret = ''; state.connecting = false; render(); }
}

async function sendAnalyticsNotice(matrixClient: MatrixClient, group: WritableGroup, sentRecipients: Recipient[]): Promise<number> {
  const config = state.config; const currentUserId = state.user?.id; if (!config?.analyticsPersonIds.length || !currentUserId) return 0;
  const expectedIds = config.analyticsPersonIds.filter(id => id !== currentUserId);
  let selected = selectedAnalyticsRecipients([...sentRecipients, ...state.analyticsMembers], expectedIds, currentUserId);
  if (selected.length < expectedIds.length) {
    const resolvedIds = new Set(selected.map(person => person.id));
    const resolvedPeople = await ct.analyticsRecipients(expectedIds.filter(id => !resolvedIds.has(id)));
    selected = selectedAnalyticsRecipients([...selected, ...resolvedPeople], expectedIds, currentUserId);
  }
  if (selected.length < expectedIds.length) {
    try {
      const adminMembers = await ct.activeChatMembers(config.adminGroupId);
      selected = selectedAnalyticsRecipients([...selected, ...adminMembers], expectedIds, currentUserId);
    } catch {
      // Reguläre Absender dürfen die Admin-Gruppe unter Umständen nicht einsehen.
    }
  }
  const unresolvedCount = expectedIds.length - selected.length;
  const matrixHost = new URL(matrixClient.baseUrl).hostname;
  const outcomes = await mapLimit(selected, 2, async person => {
    const message = `Hallo ${person.firstName || person.name}, ich habe gerade über das Broadcast-Modul für die Gruppe ${group.name} eine Nachricht an ${sentRecipients.length} ${sentRecipients.length === 1 ? 'Person' : 'Personen'} versandt.`;
    try { await matrixClient.sendText(`@ct_${person.guid.toLowerCase()}:${matrixHost}`, message); return true; }
    catch { return false; }
  });
  const failed = outcomes.filter(sent => !sent).length;
  if (unresolvedCount > 0 || failed > 0) {
    const issues = [
      unresolvedCount > 0 ? `${unresolvedCount} Empfänger konnten nicht ermittelt werden` : '',
      failed > 0 ? `${failed} Nachrichten konnten nicht zugestellt werden` : ''
    ].filter(Boolean);
    throw new Error(`${issues.join('; ')}.`);
  }
  return selected.length;
}

async function sendBroadcast(): Promise<void> {
  const matrixClient = matrix; const group = state.group; const user = state.user; const config = state.config; if (!group || !user || !config || !matrixClient?.connected) return;
  try { await loadRecipients(); } catch (error) { return setError(messageFromError(error)); }
  state.sending = true; state.progress = 0; state.results = null; state.error = ''; render(); const matrixHost = new URL(matrixClient.baseUrl).hostname; const template = state.template; const recipients = [...state.recipients];
  const results = await mapLimit(recipients, integer(String(SEND_CONCURRENCY), 3), async recipient => { try { const message = await ct.renderMessage(template, recipient.id, group.id, user.id); if (!message) throw new Error('Die personalisierte Nachricht ist leer.'); await matrixClient.sendText(`@ct_${recipient.guid.toLowerCase()}:${matrixHost}`, message); return { recipient, status: 'sent' } satisfies SendResult; } catch (error) { return { recipient, status: 'failed', error: messageFromError(error) } satisfies SendResult; } finally { state.progress++; const button = document.querySelector<HTMLButtonElement>('#send-button'); if (button) button.textContent = `Versende ${state.progress}/${recipients.length} …`; const bar = document.querySelector<HTMLElement>('.progress span'); if (bar) bar.style.width = `${Math.round((state.progress / recipients.length) * 100)}%`; } });
  state.results = results;
  const sentRecipients = results.filter(result => result.status === 'sent').map(result => result.recipient);
  try {
    const analyticsCount = await sendAnalyticsNotice(matrixClient, group, sentRecipients);
    if (analyticsCount > 0) state.notice = `${analyticsCount} Analytics-${analyticsCount === 1 ? 'Nachricht wurde' : 'Nachrichten wurden'} zugestellt.`;
  } catch (error) {
    state.notice = `Der Broadcast wurde versandt, aber die Analytics-Benachrichtigung ist fehlgeschlagen: ${messageFromError(error)}`;
  }
  state.sending = false; state.preview = ''; render();
}

async function initialize(): Promise<void> {
  try {
    state.user = await ct.currentUser();
    if (!state.user?.id || !state.user.guid) throw new Error('Bitte melde dich zuerst in ChurchTools an.');
    const matrixBaseUrl = window.settings?.chatServer || 'https://chat.church.tools'; matrix = new MatrixClient(matrixBaseUrl, matrixUserId(state.user.guid, matrixBaseUrl));
    state.config = await configurationStore.load();
    if (!state.config) {
      if (!(await ct.canInitializeConfiguration())) throw new ConfigurationAccessError();
      state.setupGroups = await ct.ownActiveGroups(state.user);
      state.view = 'setup';
      if (!state.setupGroups.length) throw new Error('Für die Ersteinrichtung musst du aktives Mitglied mindestens einer sichtbaren Gruppe sein.');
    }
    else {
      const access = await ct.configurationAccess(state.user, state.config);
      state.isAdmin = access.isAdmin;
      state.groups = access.groups;
      if (access.isAdmin) {
        void repairAdminConfiguration(state.config);
      }
      state.view = access.groups.length || access.isAdmin ? 'broadcast' : 'denied';
      if (access.groups.length) await connectChat();
    }
  } catch (error) { if (error instanceof ConfigurationAccessError) state.view = 'denied'; state.error = messageFromError(error); }
  finally { state.initializing = false; render(); }
}

window.addEventListener('pagehide', () => { matrix = null; removeThemeSync(); });
await initialize();
