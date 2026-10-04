import type { PlaceholderItem, PlaceholderOption } from './types';

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function templateToHtml(template: string): string {
  return escapeHtml(template).replaceAll(/\r?\n/g, '<br>');
}

export function htmlToPlainText(html: string): string {
  return html
    .replaceAll(/<\s*br\s*\/?\s*>/gi, '\n')
    .replaceAll(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      const key = entity.toLowerCase();
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      return entities[key] ?? match;
    })
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

export function flattenPlaceholders(items: PlaceholderItem[], parents: string[] = []): PlaceholderOption[] {
  const output: PlaceholderOption[] = [];
  for (const item of items) {
    const groupName = item.name || item.menuLabel || item.title;
    const nextParents = groupName ? [...parents, groupName] : parents;
    const discoveredPlaceholder = item.placeholder || Object.values(item).find(
      value => typeof value === 'string' && /^\{\{[\s\S]+\}\}$/.test(value)
    );
    if (typeof discoveredPlaceholder === 'string') {
      output.push({
        label: item.label || item.name || item.menuLabel || item.title || discoveredPlaceholder,
        path: parents.join(' · '),
        placeholder: discoveredPlaceholder
      });
    }
    const childCollections = Object.values(item).filter(
      value => Array.isArray(value) && value.every(child => child && typeof child === 'object')
    ) as PlaceholderItem[][];
    for (const children of childCollections) output.push(...flattenPlaceholders(children, nextParents));
  }
  return [...new Map(output.map(item => [item.placeholder, item])).values()];
}

const STANDARD_PLACEHOLDER_TUPLES: Array<[string, string, string]> = [
  ['Formelle Anrede', 'Person · Anrede', '{{person.salutationFormal}}'],
  ['Informelle Anrede', 'Person · Anrede', '{{person.salutationInformal}}'],
  ['Titel', 'Person · Name', '{{person.title}}'],
  ['Vorname', 'Person · Name', '{{person.firstName}}'],
  ['Nachname', 'Person · Name', '{{person.lastName}}'],
  ['Rufname', 'Person · Name', '{{person.nickname}}'],
  ['Straße', 'Person · Adresse', '{{person.street}}'],
  ['Adresszusatz', 'Person · Adresse', '{{person.addressAddition}}'],
  ['PLZ', 'Person · Adresse', '{{person.zip}}'],
  ['Ort', 'Person · Adresse', '{{person.city}}'],
  ['Land', 'Person · Adresse', '{{person.country}}'],
  ['Geschlecht', 'Person', '{{person.sex}}'],
  ['Geschlecht (ID)', 'Person', '{{person.sexId}}'],
  ['Telefon privat', 'Person · Kontakt', '{{person.phonePrivate}}'],
  ['Telefon geschäftlich', 'Person · Kontakt', '{{person.phoneWork}}'],
  ['Mobiltelefon', 'Person · Kontakt', '{{person.mobile}}'],
  ['Fax', 'Person · Kontakt', '{{person.fax}}'],
  ['E-Mail', 'Person · Kontakt', '{{person.email}}'],
  ['Benutzername', 'Person', '{{person.cmsUserId}}'],
  ['Personen-ID', 'Person', '{{person.id}}'],
  ['Personen-GUID', 'Person', '{{person.guid}}'],
  ['Gruppenname', 'Gruppe', '{{group.name}}'],
  ['Wochentag', 'Gruppe', '{{group.meetingday}}'],
  ['Startzeit', 'Gruppe', '{{group.meetingtime}}'],
  ['Treffpunkt', 'Gruppe', '{{group.meetingplace}}'],
  ['Gruppentyp', 'Gruppe', '{{grouptype.name}}'],
  ['Gruppen-ID', 'Gruppe', '{{group.id}}'],
  ['Check-in-Code', 'Gruppenmitgliedschaft', '{{groupMember.checkinCode}}'],
  ['Rolle', 'Gruppenmitgliedschaft', '{{groupMember.role}}'],
  ['Status', 'Gruppenmitgliedschaft', '{{groupMember.status}}'],
  ['Eintrittsdatum', 'Gruppenmitgliedschaft', '{{groupMember.startDate}}'],
  ['Enddatum', 'Gruppenmitgliedschaft', '{{groupMember.endDate}}'],
  ['Wartelistenplatz', 'Gruppenmitgliedschaft', '{{groupMember.waitinglistPosition}}'],
  ['Angemeldet von', 'Gruppenmitgliedschaft · Angemeldet von', '{{groupMember.registeredBy}}'],
  ['Vorname des Anmeldenden', 'Gruppenmitgliedschaft · Angemeldet von', '{{groupMember.registeredBy-firstName}}'],
  ['Nachname des Anmeldenden', 'Gruppenmitgliedschaft · Angemeldet von', '{{groupMember.registeredBy-lastName}}'],
  ['E-Mail des Anmeldenden', 'Gruppenmitgliedschaft · Angemeldet von', '{{groupMember.registeredBy-email}}'],
  ['Personen-ID des Anmeldenden', 'Gruppenmitgliedschaft · Angemeldet von', '{{groupMember.registeredBy-id}}']
];

export const STANDARD_PLACEHOLDERS: PlaceholderOption[] = STANDARD_PLACEHOLDER_TUPLES.map(
  ([label, path, placeholder]) => ({ label, path, placeholder })
);

function normalizedPlaceholder(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase('de');
}

function normalizedPlaceholderLabel(item: PlaceholderOption): string {
  return `${item.path}::${item.label}`.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
}

export function mergePlaceholders(...lists: PlaceholderOption[][]): PlaceholderOption[] {
  const byPlaceholder = new Map<string, PlaceholderOption>();
  for (const list of lists) {
    for (const item of list) byPlaceholder.set(normalizedPlaceholder(item.placeholder), item);
  }
  const byLabel = new Map<string, PlaceholderOption>();
  for (const item of byPlaceholder.values()) byLabel.set(normalizedPlaceholderLabel(item), item);
  return [...byLabel.values()].sort((a, b) => `${a.path} ${a.label}`.localeCompare(`${b.path} ${b.label}`, 'de'));
}

export function validateTemplate(template: string, maxLength = 5000): string | null {
  if (!template.trim()) return 'Bitte gib eine Nachricht ein.';
  if (template.length > maxLength) return `Die Nachricht darf höchstens ${maxLength} Zeichen lang sein.`;
  return null;
}
