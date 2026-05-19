const REPLACEMENT_CHARACTER = "\uFFFD";

export function stringifyJsonForPostgres(value: unknown): string {
  const replacer = (_key: string, item: unknown): unknown =>
    typeof item === "string" ? replaceLoneSurrogates(item) : item;
  const serialized = JSON.stringify(value, replacer);
  if (serialized === undefined) return "null";
  return serialized;
}

export function replaceLoneSurrogates(input: string): string {
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = input.charCodeAt(index + 1);
      if (isLowSurrogate(nextCodeUnit)) {
        output += input[index] ?? "";
        output += input[index + 1] ?? "";
        index += 1;
      } else {
        output += REPLACEMENT_CHARACTER;
      }
      continue;
    }

    if (isLowSurrogate(codeUnit)) {
      output += REPLACEMENT_CHARACTER;
      continue;
    }

    output += input[index] ?? "";
  }

  return output;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
