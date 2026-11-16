/** Joins the present items with ", " when all of them are ASCII, else with the full-width "，". */
export function listText(...parts: (string | null | undefined | false)[]): string {
  const present = parts.filter((p): p is string => Boolean(p));
  return present.join(present.every((p) => /^[\x00-\x7F]*$/.test(p)) ? ', ' : '，');
}
