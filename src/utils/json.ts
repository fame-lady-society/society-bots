export const bigIntToStringJsonFormat = (key: string, value: any) => {
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  return value;
};

export const stringToBaseInt = (key: string, value: any) => {
  if (typeof value === "string" && value.startsWith("bigint:")) {
    return BigInt(value.slice(7));
  }
  return value;
};

type ConvertStringToBigInt<T> = T extends object
  ? { [K in keyof T]: ConvertStringToBigInt<T[K]> }
  : T extends string
  ? T extends `bigint:${infer _}`
    ? bigint
    : T
  : T;

export const convertStringObjectToBigInt = <T>(
  obj: T
): ConvertStringToBigInt<T> => {
  return JSON.parse(
    JSON.stringify(obj),
    stringToBaseInt
  ) as ConvertStringToBigInt<T>;
};
