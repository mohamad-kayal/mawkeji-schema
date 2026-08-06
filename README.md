# mawkeji-schema

Generated mirror. **Do not edit here.** The authoritative copies live in
the private `mawkeji` platform repo at `schema/site-data.schema.json`
and `scripts/validate.js`; this repo is overwritten by that repo's
CI on every CMS deploy (D18).

It exists so customer-repo CI can validate `site-data.json` without a
credential. Usage (from this repo's root):

    npm i
    node scripts/validate.js path/to/site-data.json
