// Tagged-template SQL builder: values become bound `?` parameters, nested Sql
// fragments are inlined with their parameters. No string concatenation of values.

export interface Sql {
  readonly text: string;
  readonly params: readonly unknown[];
}

const SQL = Symbol("sql");
type Frag = Sql & { [SQL]: true };

export function sql(strings: TemplateStringsArray, ...values: unknown[]): Frag {
  let text = strings[0] ?? "";
  const params: unknown[] = [];
  values.forEach((v, i) => {
    if (isSql(v)) {
      text += v.text;
      params.push(...v.params);
    } else {
      text += "?";
      params.push(v === undefined ? null : v);
    }
    text += strings[i + 1] ?? "";
  });
  return { text, params, [SQL]: true };
}

export function isSql(v: unknown): v is Frag {
  return typeof v === "object" && v !== null && (v as Frag)[SQL] === true;
}

/** Inline a fixed SQL keyword/identifier list chosen by code, never by input. */
export function raw(text: string): Frag {
  return { text, params: [], [SQL]: true };
}

export function join(frags: Sql[], sep: string): Frag {
  return {
    text: frags.map((f) => f.text).join(sep),
    params: frags.flatMap((f) => f.params),
    [SQL]: true,
  };
}

/** `IN (...)` list of literal role names; roles are code constants. */
export function inList(values: readonly string[]): Frag {
  return join(values.map((v) => sql`${v}`), ", ");
}
