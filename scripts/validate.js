// Validates a site-data payload against the canonical contract (schema/SCHEMA.md).
// The same code runs from this file's CLI and from scripts/inject.js, which
// validates before every injection; publishSite will call it too. There is no
// second implementation, so invalid data cannot reach a page.
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ajv ships CommonJS: the default import is the module namespace under some
// loaders and the constructor under others.
const Ajv = Ajv2020.default ?? Ajv2020;

const schema = JSON.parse(readFileSync(new URL('../schema/site-data.schema.json', import.meta.url)));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const compiled = ajv.compile(schema);

// Ajv's bare message hides the two things a person needs: which key drifted,
// and what the closed list actually allows.
function describe(e) {
  const where = e.instancePath || '/';
  if (e.keyword === 'additionalProperties') {
    return `${where} must NOT have additional property "${e.params.additionalProperty}"`;
  }
  if (e.keyword === 'enum') {
    return `${where} ${e.message}: ${e.params.allowedValues.join(', ')}`;
  }
  return `${where} ${e.message}`;
}

// Integrity JSON Schema cannot express. Both failures are silent in a browser:
// a typo'd categoryId or a duplicated id makes an item vanish from a live
// catalogue without breaking anything visible. Ids are unique per array only —
// a nav id and a category id may match, and often do.
const ID_ARRAYS = ['items', 'categories', 'nav', 'packages', 'servicePages', 'gallery', 'testimonials', 'faq'];

function referentialErrors(data) {
  const errors = [];
  const arr = key => (Array.isArray(data?.[key]) ? data[key] : []);
  for (const key of ID_ARRAYS) {
    const seen = new Set();
    arr(key).forEach((entry, i) => {
      const id = entry?.id;
      if (typeof id !== 'string') return;
      if (seen.has(id)) errors.push(`/${key}/${i}/id duplicate id "${id}"`);
      seen.add(id);
    });
  }
  const categoryIds = new Set(arr('categories').map(c => c?.id));
  arr('items').forEach((item, i) => {
    if (typeof item?.categoryId === 'string' && !categoryIds.has(item.categoryId)) {
      errors.push(`/items/${i}/categoryId "${item.categoryId}" not found in categories`);
    }
  });
  // themeExtras category refs (2026-08-05 audit P6): themes park category-id
  // foreign keys under themeExtras[<own theme slug>] using a *CategoryId /
  // *CategoryIds naming convention (e.g. sweets' traysCategoryId,
  // electronics' accessoryCategoryIds). A dangling ref silently empties a
  // whole view in the browser — same failure class as items[].categoryId
  // above. Checked by KEY SHAPE only, top-level keys only, and only for the
  // payload's own theme slug: this stays theme-agnostic (no per-theme
  // knowledge) and absence stays legal (no themeExtras, no slug key, or a
  // value of another type = nothing to check).
  const slug = data?.meta?.themeId;
  const extras = data?.themeExtras?.[slug];
  if (extras && typeof extras === 'object' && !Array.isArray(extras)) {
    for (const [key, value] of Object.entries(extras)) {
      if (/CategoryId$/.test(key) && typeof value === 'string' && !categoryIds.has(value)) {
        errors.push(`/themeExtras/${slug}/${key} "${value}" not found in categories`);
      }
      if (/CategoryIds$/.test(key) && Array.isArray(value)) {
        value.forEach((v, i) => {
          if (typeof v === 'string' && !categoryIds.has(v)) {
            errors.push(`/themeExtras/${slug}/${key}/${i} "${v}" not found in categories`);
          }
        });
      }
    }
  }
  return errors;
}

export function validateSiteData(data) {
  compiled(data);
  const errors = (compiled.errors ?? []).map(describe).concat(referentialErrors(data));
  return { valid: errors.length === 0, errors };
}

// CLI: node scripts/validate.js <file.json>
// pathToFileURL, not `file://` + path: import.meta.url percent-encodes spaces
// and non-ASCII, so naive concatenation never matches under such a path. The
// argv[1] test keeps an import from a REPL (no entry script) from throwing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/validate.js <file.json>');
    process.exit(1);
  }
  const r = validateSiteData(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.valid) {
    console.error(r.errors.join('\n'));
    process.exit(1);
  }
  console.log('valid');
}
