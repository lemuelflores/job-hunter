export type TitleExpression =
  | string
  | { op: 'and' | 'or'; terms: TitleExpression[] };

export function and(...terms: TitleExpression[]): TitleExpression {
  return { op: 'and', terms };
}

export function or(...terms: TitleExpression[]): TitleExpression {
  return { op: 'or', terms };
}
