/**
 * 原始 JSON 文本的重复键检测。`JSON.parse` 会静默保留最后一个同名键，使
 * “签了/算过摘要的文档”在不同解析器下含义不同；Rust 宿主已拒绝重复键，
 * 开发用 CLI 也必须在解析前拒绝，不能让 TS 侧把同一份包判为有效。
 *
 * 输入假定已是合法 JSON（调用方先跑 `JSON.parse` 校验）；本函数只负责
 * 结构化扫描并返回是否出现重复对象键，键按 JSON 解码后的语义比较
 * （`"\u0061"` 与 `"a"` 相同）。
 */
export function hasDuplicateJsonKeys(text: string): boolean {
  const length = text.length;
  let index = 0;
  const DUP = Symbol("duplicate");
  const invalid = () => { throw new Error("invalid JSON"); };
  const skipWhitespace = () => { while (index < length && /\s/.test(text[index])) index += 1; };
  const readString = (): string => {
    if (text[index] !== '"') invalid();
    const start = index++;
    let escaped = false;
    while (index < length) {
      const char = text[index++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    return invalid();
  };
  const readValue = (depth: number): void => {
    if (depth > 256) invalid();
    skipWhitespace();
    const char = text[index];
    if (char === '"') { readString(); return; }
    if (char === "{") { readObject(depth + 1); return; }
    if (char === "[") { readArray(depth + 1); return; }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    if (!literal) throw new Error("invalid JSON");
    index += literal[0].length;
  };
  const readObject = (depth: number): void => {
    index += 1;
    const keys = new Set<string>();
    skipWhitespace();
    if (text[index] === "}") { index += 1; return; }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') invalid();
      const key = readString();
      if (keys.has(key)) throw DUP;
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") invalid();
      index += 1;
      readValue(depth);
      skipWhitespace();
      if (text[index] === ",") { index += 1; continue; }
      if (text[index] === "}") { index += 1; return; }
      invalid();
    }
  };
  const readArray = (depth: number): void => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") { index += 1; return; }
    for (;;) {
      readValue(depth);
      skipWhitespace();
      if (text[index] === ",") { index += 1; continue; }
      if (text[index] === "]") { index += 1; return; }
      invalid();
    }
  };
  try {
    readValue(0);
    skipWhitespace();
    if (index !== length) invalid();
  } catch (error) {
    if (error === DUP) return true;
    throw new Error("invalid JSON");
  }
  return false;
}
