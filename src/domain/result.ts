/**
 * Result + Option ADTs. Domain returns `Result<E, T>`; adapters convert
 * thrown exceptions into typed `Err`. Mirrors the project conventions
 * from CODING_CONVENTIONS_TYPESCRIPT.md.
 */

export type Result<E, T> =
  | { readonly tag: "Ok"; readonly value: T }
  | { readonly tag: "Err"; readonly error: E };

export const Ok = <T>(value: T): Result<never, T> => ({ tag: "Ok", value });
export const Err = <E>(error: E): Result<E, never> => ({ tag: "Err", error });

export const isOk = <E, T>(r: Result<E, T>): r is { readonly tag: "Ok"; readonly value: T } =>
  r.tag === "Ok";
export const isErr = <E, T>(r: Result<E, T>): r is { readonly tag: "Err"; readonly error: E } =>
  r.tag === "Err";

export type Option<T> = { readonly tag: "Some"; readonly value: T } | { readonly tag: "None" };
export const Some = <T>(value: T): Option<T> => ({ tag: "Some", value });
export const None: Option<never> = { tag: "None" };
