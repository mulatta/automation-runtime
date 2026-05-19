import { replaceLoneSurrogates, stringifyJsonForPostgres } from "../src/json";

describe("replaceLoneSurrogates", () => {
  it("preserves valid surrogate pairs", () => {
    expect(replaceLoneSurrogates("ok 😀 text")).toBe("ok 😀 text");
  });

  it("replaces unpaired high and low surrogates", () => {
    expect(replaceLoneSurrogates("bad \ud835 text \udc00")).toBe(
      "bad � text �",
    );
  });
});

describe("stringifyJsonForPostgres", () => {
  it("sanitizes nested strings before PostgreSQL jsonb casts", () => {
    expect(
      stringifyJsonForPostgres({
        type: "terminal_auth_cookie_invalid",
        message: "bad \ud835 title",
        nested: [{ stderr: "also \udc00 bad" }],
      }),
    ).toBe(
      '{"type":"terminal_auth_cookie_invalid","message":"bad � title","nested":[{"stderr":"also � bad"}]}',
    );
  });
});
