import * as v from 'valibot';

export interface CandidatePreferences {
  location: string;
  stack: string[];
}

const nonblank = v.pipe(
  v.string(),
  v.check((value) => Boolean(value.trim()), 'Value must not be blank'),
);

export const CandidateSchema: v.GenericSchema<unknown, CandidatePreferences> =
  v.strictObject({
    location: nonblank,
    stack: v.pipe(v.array(nonblank), v.minLength(1)),
  });
