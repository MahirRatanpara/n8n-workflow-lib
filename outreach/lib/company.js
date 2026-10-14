// ── company.js ──────────────────────────────────────────────────────────────
// Resolve any spelling of a company (LinkedIn display name, Cowork output,
// legacy sheet text) to the Companies tab's CompanyID. Never guesses: if two
// different IDs match, or nothing matches, it returns ''.

const COMPANY_NOISE = new Set([
  'technologies', 'technology', 'tech', 'group', 'india', 'private', 'pvt', 'limited', 'ltd',
  'inc', 'llc', 'llp', 'corp', 'corporation', 'co', 'company', 'holdings', 'holding', 'advertising',
  'global', 'labs', 'software', 'systems', 'services', 'solutions', 'the', 'and', 'plc', 'gmbh',
]);

function companyTokens(name) {
  return str(name).toLowerCase()
    .replace(/\(.*?\)/g, ' ')          // "(NASDAQ: BKNG)", "(Disney+)"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}
function companyKeyExact(name) { return companyTokens(name).join(''); }
function companyKeyLoose(name) {
  const t = companyTokens(name);
  const kept = t.filter(w => !COMPANY_NOISE.has(w));
  return (kept.length ? kept : t).join('');
}

// rows: Companies tab objects with Company, CompanyID, Aliases (';' or ',' separated)
function buildCompanyIndex(rows) {
  const exact = new Map(), loose = new Map(), names = new Map();
  const add = (map, key, id) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };
  for (const r of rows || []) {
    const id = str(r.CompanyID);
    if (!id) continue;
    if (!names.has(id)) names.set(id, str(r.Company));
    const variants = [str(r.Company), ...str(r.Aliases).split(/[;,|]/)].map(s => s.trim()).filter(Boolean);
    for (const v of variants) { add(exact, companyKeyExact(v), id); add(loose, companyKeyLoose(v), id); }
  }
  return { exact, loose, names };
}

function resolveCompany(index, name) {
  if (!index || !str(name)) return '';
  const pick = (set) => (set && set.size === 1 ? [...set][0] : '');
  const e = index.exact.get(companyKeyExact(name));
  if (e && e.size === 1) return pick(e);
  if (e && e.size > 1) return '';
  return pick(index.loose.get(companyKeyLoose(name)));
}
