// Parameterized SQL only. Provider text never becomes SQL syntax or a prompt.
const lists = { providers: 'm.provider', accounts: 'm.account', kinds: 'p.kind', categories: 'm.category', severity: 'm.severity' };
const contains = value => `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
export function ftsPrefix(text) {
  return (String(text).match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0,32).map(word => `"${word}"*`).join(' AND ');
}
export function filterToSql(filter = {}, { defaults = true } = {}) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Filter must be an object');
  const where = [], params = [];
  const add = (sql, ...values) => { where.push(sql); params.push(...values); };
  for (const [key,column] of Object.entries(lists)) if (filter[key] !== undefined) {
    if (!Array.isArray(filter[key]) || filter[key].some(v => typeof v !== 'string')) throw new Error(`Invalid ${key}`);
    if (!filter[key].length) add('0');
    else add(`${column} IN (${filter[key].map(() => '?').join(',')})`, ...filter[key]);
  }
  for (const key of ['archived','deleted','starred']) {
    if (filter[key] !== undefined && typeof filter[key] !== 'boolean') throw new Error(`Invalid ${key}`);
    if (filter[key] !== undefined || (defaults && key !== 'starred')) add(`m.${key}=?`, filter[key] ? 1 : 0);
  }
  if (filter.unread !== undefined) add('m.read=?',filter.unread ? 0 : 1);
  if (filter.actionable !== undefined) add(`${filter.actionable ? '' : 'NOT '}COALESCE((
    m.provider='system' AND json_extract(m.action,'$.kind') IN ('question','approval','revert','cancel-send')
    AND json_extract(m.action,'$.answeredAt') IS NULL
    AND (json_extract(m.action,'$.revertUntil') IS NULL OR json_extract(m.action,'$.revertUntil') > strftime('%Y-%m-%dT%H:%M:%fZ','now'))),0) `);
  if (filter.text) { const query = ftsPrefix(filter.text); add(query ? 'm.id IN (SELECT messageId FROM messages_fts WHERE messages_fts MATCH ?)' : '0', ...(query ? [query] : [])); }
  if (filter.from) add("(lower(json_extract(m.sender,'$.name')) LIKE lower(?) ESCAPE '\\' OR lower(json_extract(m.sender,'$.address')) LIKE lower(?) ESCAPE '\\')", contains(filter.from), contains(filter.from));
  if (filter.conversationId) add('m.conversationId=?',String(filter.conversationId));
  if (filter.direction) add('m.direction=?',String(filter.direction));
  if (filter.hasAttachments !== undefined) add(`json_array_length(m.attachments) ${filter.hasAttachments ? '>' : '='} 0`);
  if (filter.attachmentKind) add("EXISTS (SELECT 1 FROM json_each(m.attachments) WHERE json_extract(value,'$.kind')=?)",String(filter.attachmentKind));
  if (filter.labels !== undefined) {
    if (!Array.isArray(filter.labels)) throw new Error('Invalid labels');
    if (!filter.labels.length) add('0');
    else add(`EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value IN (${filter.labels.map(() => '?').join(',')}))`,...filter.labels);
  }
  for (const [key,operator] of [['dateFrom','>='],['dateTo','<=']]) if (filter[key]) {
    const date = new Date(filter[key]); if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${key}`);
    add(`m.ts ${operator} ?`, date.toISOString());
  }
  for (const [key,column] of [['subjectContains','subject'],['bodyContains','bodyText']]) if (filter[key]) add(`lower(m.${column}) LIKE lower(?) ESCAPE '\\'`,contains(filter[key]));
  if (filter.senderIs?.length) add(`lower(COALESCE(json_extract(m.sender,'$.address'),json_extract(m.sender,'$.id'))) IN (${filter.senderIs.map(() => '?').join(',')})`,...filter.senderIs.map(v => String(v).toLowerCase()));
  return { sql: where.length ? where.join(' AND ') : '1', params };
}
