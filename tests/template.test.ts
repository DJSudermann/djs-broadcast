import { describe, expect, it } from 'vitest';
import { flattenPlaceholders, htmlToPlainText, mergePlaceholders, templateToHtml, validateTemplate } from '../src/template';

describe('template helpers', () => {
  it('preserves ChurchTools placeholders while escaping authored HTML', () => {
    expect(templateToHtml('Hallo {{person.firstName}}\n<script>alert(1)</script>')).toBe(
      'Hallo {{person.firstName}}<br>&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('converts a rendered ChurchTools preview to Matrix plain text', () => {
    expect(htmlToPlainText('<p>Hallo Anna,<br>willkommen &amp; bis bald!</p>')).toBe(
      'Hallo Anna,\nwillkommen & bis bald!'
    );
  });

  it('flattens the recursive placeholder menu', () => {
    expect(
      flattenPlaceholders([
        { name: 'Person', items: [{ name: 'Adresse', items: [{ label: 'Vorname', placeholder: '{{person.firstName}}' }] }] }
      ])
    ).toEqual([{ label: 'Vorname', path: 'Person · Adresse', placeholder: '{{person.firstName}}' }]);
  });

  it('keeps leaves that use name as their label and supports children', () => {
    expect(flattenPlaceholders([
      { menuLabel: 'Person', children: [{ name: 'Vorname', placeholder: '{{person.firstName}}' }] }
    ])).toEqual([{ label: 'Vorname', path: 'Person', placeholder: '{{person.firstName}}' }]);
  });

  it('discovers placeholders in additional API collections and value fields', () => {
    expect(flattenPlaceholders([
      { title: 'Eigene Felder', entries: [{ label: 'T-Shirt', value: '{{person.tshirt}}' }] }
    ])).toEqual([{ label: 'T-Shirt', path: 'Eigene Felder', placeholder: '{{person.tshirt}}' }]);
  });

  it('merges dynamic placeholders over fallback entries without duplicates', () => {
    expect(mergePlaceholders(
      [{ label: 'Fallback', path: 'Person', placeholder: '{{person.firstName}}' }],
      [{ label: 'Vorname', path: 'Eigene Felder', placeholder: '{{person.firstName}}' }]
    )).toEqual([{ label: 'Vorname', path: 'Eigene Felder', placeholder: '{{person.firstName}}' }]);
  });

  it('deduplicates equivalent placeholders and duplicate labels from different catalogs', () => {
    expect(mergePlaceholders(
      [{ label: 'Gruppen-ID', path: 'Gruppe', placeholder: '{{ group.id }}' }],
      [{ label: 'Gruppen-ID', path: 'Gruppe', placeholder: '{{group.id}}' }],
      [{ label: 'Gruppen-ID', path: 'Gruppe', placeholder: '{{group.domainIdentifier}}' }]
    )).toEqual([{ label: 'Gruppen-ID', path: 'Gruppe', placeholder: '{{group.domainIdentifier}}' }]);
  });

  it('validates empty and oversized messages', () => {
    expect(validateTemplate('   ')).toMatch(/Nachricht/);
    expect(validateTemplate('a'.repeat(5001))).toMatch(/5000/);
    expect(validateTemplate('Hallo')).toBeNull();
  });
});
