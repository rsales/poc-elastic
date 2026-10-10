export const queryScalar = (value, name) => {
  if (Array.isArray(value) || (value !== undefined && typeof value === 'object')) {
    const error = new Error(`"${name}" must be a single value`);
    error.status = 400;
    throw error;
  }
  return value == null ? undefined : String(value);
};

export const parseInteger = (value, { name, defaultValue, min, max }) => {
  if (value === undefined || value === '') return defaultValue;
  if (!/^-?\d+$/.test(String(value))) {
    const error = new Error(`"${name}" must be an integer`);
    error.status = 400;
    throw error;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max != null && parsed > max)) {
    const error = new Error(`"${name}" must be between ${min} and ${max ?? 'the safe integer limit'}`);
    error.status = 400;
    throw error;
  }
  return parsed;
};

export const parseRating = (value) => {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
    const error = new Error('"minRating" must be a number between 0 and 10');
    error.status = 400;
    throw error;
  }
  return parsed;
};
