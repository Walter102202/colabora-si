// Minimal JSON Schema (2020-12 subset) used by the tool definitions: validation of tool arguments
// and inlining of `$defs` for hosts that do not resolve `$ref`.

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  title?: string;
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  default?: unknown;
  [key: string]: unknown;
};

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  return m ? root.$defs?.[m[1]] : undefined;
}

/** Returns the list of validation errors (empty when the value is valid). */
export function validate(schema: JsonSchema, value: unknown, root: JsonSchema = schema, path = '$'): string[] {
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    return target ? validate(target, value, root, path) : [`${path}: unresolved ${schema.$ref}`];
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) return [`${path}: expected ${types.join(' or ')}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items!, item, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const prop = schema.properties?.[key];
      if (prop) errors.push(...validate(prop, v, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, root, `${path}.${key}`));
      }
    }
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value, root, path).length === 0)) {
    errors.push(`${path}: does not match any allowed shape`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    if (matches !== 1) errors.push(`${path}: must match exactly one allowed shape`);
  }
  return errors;
}

/** Copy of the schema with every `#/$defs/X` reference replaced by the definition and `$defs` removed. */
export function inlineRefs(schema: JsonSchema, root: JsonSchema = schema, depth = 0): JsonSchema {
  if (depth > 20) return {};
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    return target ? inlineRefs(target, root, depth + 1) : {};
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$defs') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, inlineRefs(v, root, depth + 1)]),
      );
    } else if ((key === 'items' || key === 'additionalProperties') && value && typeof value === 'object') {
      out[key] = inlineRefs(value as JsonSchema, root, depth + 1);
    } else if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      out[key] = value.map((v) => inlineRefs(v as JsonSchema, root, depth + 1));
    } else {
      out[key] = value;
    }
  }
  return out;
}
