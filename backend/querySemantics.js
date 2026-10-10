// Keep broad recall for ordinary searches, but use AND when an exclusion
// operator is present so a query like '"Spider-Man" -Homecoming' cannot match
// every document that simply does not contain Homecoming.
export const getDefaultOperator = (q = '') => {
  const hasExclusion = /(^|\s)-\S/.test(q);
  return hasExclusion ? 'AND' : 'OR';
};
