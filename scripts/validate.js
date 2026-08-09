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

// themeExtras stays additionalProperties: true by design (the namespaced
// per-theme escape hatch, SCHEMA.md §11 item 7) — JSON Schema alone can't cap
// its *total serialized size*, so that cap lives here instead. Measured with
// compact JSON.stringify (no spacing), matching the already-parsed JS object
// this function receives, not the on-disk pretty-printed file.
const THEME_EXTRAS_MAX_CHARS = 20000;

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
  // ajv's bare oneOf message ("must match exactly one schema in oneOf") names
  // neither key in tension, and its companion lines ("must NOT be valid") are
  // worse. Spec rows are the only place this contract uses oneOf, so the
  // mapping is unambiguous.
  if (e.keyword === 'oneOf' && /^\/items\/\d+\/specs\/\d+$/.test(where)) {
    return `${where} must carry exactly one of "fieldId" (current) or "label" (deprecated, D51 migration window)`;
  }
  return `${where} ${e.message}`;
}

// Integrity JSON Schema cannot express. Both failures are silent in a browser:
// a typo'd categoryId or a duplicated id makes an item vanish from a live
// catalogue without breaking anything visible. Ids are unique per array only —
// a nav id and a category id may match, and often do.
const ID_ARRAYS = ['items', 'categories', 'nav', 'packages', 'servicePages', 'gallery', 'testimonials', 'faq', 'itemFields'];

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
  // itemFields refs (D51). Every one of these is silent in a browser — a bad
  // filterValue just means an item never appears under its own chip, and a
  // dangling fieldId means a tile quietly vanishes — which is exactly the §9
  // test for "validation error, not lint". Duplicate itemFields[].id rides the
  // shared ID_ARRAYS loop above.
  const fieldsById = new Map();
  arr('itemFields').forEach((f) => {
    if (typeof f?.id === 'string') fieldsById.set(f.id, f);
  });
  arr('itemFields').forEach((f, i) => {
    if (f?.filterable === true && !(Array.isArray(f.values) && f.values.length > 0)) {
      errors.push(`/itemFields/${i} filterable field "${f?.id ?? ''}" has no values`);
    }
  });
  arr('items').forEach((item, i) => {
    const rows = Array.isArray(item?.specs) ? item.specs : [];
    const seenFieldIds = new Set();
    rows.forEach((s, j) => {
      const at = `/items/${i}/specs/${j}`;
      if (typeof s?.fieldId !== 'string') {
        // A legacy label-only row (D51 migration window) cannot carry a
        // filterValue: there is no field to resolve it against.
        if (typeof s?.filterValue === 'string') errors.push(`${at}/filterValue requires fieldId`);
        return;
      }
      if (seenFieldIds.has(s.fieldId)) {
        errors.push(`${at}/fieldId duplicate "${s.fieldId}" on this item`);
      }
      seenFieldIds.add(s.fieldId);
      const field = fieldsById.get(s.fieldId);
      if (!field) {
        errors.push(`${at}/fieldId "${s.fieldId}" not found in itemFields`);
        return;
      }
      if (typeof s.filterValue === 'string'
          && !(Array.isArray(field.values) && field.values.includes(s.filterValue))) {
        errors.push(`${at}/filterValue "${s.filterValue}" not in itemFields "${s.fieldId}" values`);
      }
    });
  });
  // servicePages composition refs (2026-08-06 spec Part 3): a service page
  // names the category whose items it displays and/or one item its action
  // button adds — explicit in the entry since the rework that moved this
  // out of per-theme themeExtras glue. A dangling ref silently empties a
  // grid or kills a button in the browser — same failure class as
  // items[].categoryId above.
  const itemIds = new Set(arr('items').map(it => it?.id));
  arr('servicePages').forEach((sp, i) => {
    if (typeof sp?.itemsCategoryId === 'string' && !categoryIds.has(sp.itemsCategoryId)) {
      errors.push(`/servicePages/${i}/itemsCategoryId "${sp.itemsCategoryId}" not found in categories`);
    }
    if (typeof sp?.addItemId === 'string' && !itemIds.has(sp.addItemId)) {
      errors.push(`/servicePages/${i}/addItemId "${sp.addItemId}" not found in items`);
    }
  });
  // themeExtras category refs (2026-08-05 audit P6): themes park category-id
  // foreign keys under themeExtras[<own theme slug>] using a *CategoryId /
  // *CategoryIds naming convention (e.g. electronics' accessoryCategoryIds,
  // hall's hallCategoryIds). A dangling ref silently empties a
  // whole view in the browser — same failure class as items[].categoryId
  // above. Checked by KEY SHAPE only, top-level keys only, and only for the
  // payload's own theme slug: this stays theme-agnostic (no per-theme
  // knowledge) and absence stays legal (no themeExtras, no slug key, or a
  // value of another type = nothing to check).
  // Same class as the categoryId refs above, but into items[] instead: a
  // *ItemId / *ItemIds key under the payload's own theme slug is a foreign
  // key on items[].id (e.g. the restaurant theme's dailyMealItemId, the
  // jewelry theme's featuredItemIds). Reuses the itemIds set declared for
  // the servicePages checks above (merge of two lines that each added one).
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
      if (/ItemId$/.test(key) && typeof value === 'string' && !itemIds.has(value)) {
        errors.push(`/themeExtras/${slug}/${key} "${value}" not found in items`);
      }
      if (/ItemIds$/.test(key) && Array.isArray(value)) {
        value.forEach((v, i) => {
          if (typeof v === 'string' && !itemIds.has(v)) {
            errors.push(`/themeExtras/${slug}/${key}/${i} "${v}" not found in items`);
          }
        });
      }
    }
  }
  return errors;
}

function sizeErrors(data) {
  if (!data?.themeExtras || typeof data.themeExtras !== 'object') return [];
  const size = JSON.stringify(data.themeExtras).length;
  if (size <= THEME_EXTRAS_MAX_CHARS) return [];
  return [`/themeExtras is ${size} chars serialized, over the ${THEME_EXTRAS_MAX_CHARS}-char cap`];
}

export function validateSiteData(data) {
  compiled(data);
  const errors = (compiled.errors ?? []).map(describe).concat(referentialErrors(data), sizeErrors(data));
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
