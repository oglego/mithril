// Returns the items on a given page. Pages are numbered starting at 1.
export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
