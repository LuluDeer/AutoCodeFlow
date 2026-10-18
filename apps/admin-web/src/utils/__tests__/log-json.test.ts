/**
 * LOG-JSON-01：日志行内 JSON 载荷的识别 / 美化 / 着色（纯函数层）。
 *
 * 契约（全部为行为断言，无快照）：
 *  1) 载荷定位：行内任意位置的对象/数组都能找到，前缀（时间戳/级别）与后缀
 *     （尾随文本）原样保留；
 *  2) 保真：着色 token 顺序拼接 === 原文行（未截断时）；
 *  3) 窗口化安全：`jsonLineTokens` 永远只产出**单行**内容——不得含 \n。
 *     这是 LogWindow 固定行高（LOG_ROW_HEIGHT）成立的前提，是本组用例的
 *     核心防线（多行渲染会让虚拟滚动错行）；
 *  4) 健壮性：非法 JSON / 空行 / 非字符串 / 超长载荷 / 循环结构 / BigInt
 *     一律不抛错，返回 null 或截断结果（调用方回落原始纯文本）；
 *  5) 美化形态：`prettyJsonForLine` 给出缩进 JSON（浮层消费），超长截断。
 */
import { describe, it, expect } from 'vitest';
import {
  JSON_INLINE_MAX_CHARS,
  JSON_PAYLOAD_MAX_CHARS,
  JSON_TOKEN_MAX,
  findJsonPayload,
  formatJsonValue,
  jsonLineTokens,
  prettyJsonForLine,
  tokenizeJson,
  type JsonToken,
} from '../logLevel';

const join = (tokens: JsonToken[]) => tokens.map((t) => t.text).join('');

describe('findJsonPayload：行内 JSON 载荷定位', () => {
  it('识别行首对象、级别标注后的对象、键值前缀后的对象', () => {
    expect(findJsonPayload('{"a":1}')?.value).toEqual({ a: 1 });
    expect(findJsonPayload('[INFO] {"a":1}')?.value).toEqual({ a: 1 });
    expect(findJsonPayload('2026-09-06 10:00:01 [ERROR] {"code":"E1"}')?.value).toEqual({
      code: 'E1',
    });
    expect(findJsonPayload('result={"ok":true} done')?.value).toEqual({ ok: true });
    expect(findJsonPayload('payload: [1,2,3]')?.value).toEqual([1, 2, 3]);
  });

  it('载荷位置精确（start 含 / end 不含），前后缀可无损切回', () => {
    const line = '[WARN] body={"k":"v"} tail';
    const p = findJsonPayload(line)!;
    expect(line.slice(0, p.start)).toBe('[WARN] body=');
    expect(line.slice(p.start, p.end)).toBe('{"k":"v"}');
    expect(line.slice(p.end)).toBe(' tail');
  });

  it('字符串内的括号不参与配平（含转义引号）', () => {
    const line = '{"msg":"a } b ] c","q":"he said \\"}\\" ok"}';
    expect(findJsonPayload(line)?.value).toEqual({
      msg: 'a } b ] c',
      q: 'he said "}" ok',
    });
  });

  it('首个括号不是合法 JSON 时继续向后找', () => {
    // `{not json}` 不是合法载荷，真正的载荷在其后
    expect(findJsonPayload('x {not json} y {"real":1}')?.value).toEqual({ real: 1 });
  });

  it('无载荷 / 非法 JSON / 非对象标量 / 空值 / 非字符串 → null（不抛错）', () => {
    expect(findJsonPayload('plain text only')).toBeNull();
    expect(findJsonPayload('{"a":1')).toBeNull(); // 缺右括号
    expect(findJsonPayload('{oops}')).toBeNull(); // 括号配平但内容非法
    expect(findJsonPayload('42')).toBeNull(); // 标量不是载荷
    expect(findJsonPayload('"str"')).toBeNull();
    expect(findJsonPayload('')).toBeNull();
    expect(findJsonPayload(null)).toBeNull();
    expect(findJsonPayload(undefined)).toBeNull();
    expect(findJsonPayload(123 as unknown as string)).toBeNull();
  });

  it('超过 JSON_PAYLOAD_MAX_CHARS 的行直接放弃（防大载荷解析卡顿）', () => {
    const huge = `{"k":"${'x'.repeat(JSON_PAYLOAD_MAX_CHARS)}"}`;
    expect(huge.length).toBeGreaterThan(JSON_PAYLOAD_MAX_CHARS);
    expect(findJsonPayload(huge)).toBeNull();
    // 边界内仍可解析
    const ok = `{"k":"${'x'.repeat(10)}"}`;
    expect(findJsonPayload(ok)?.value).toEqual({ k: 'xxxxxxxxxx' });
  });
});

describe('tokenizeJson：五档着色', () => {
  it('区分键 / 字符串值 / 数字 / 字面量 / 标点', () => {
    const tokens = tokenizeJson('{"k":"v","n":-1.5e3,"b":true,"z":null}');
    const kinds = tokens.map((tk) => tk.kind);
    expect(kinds).toContain('key');
    expect(kinds).toContain('string');
    expect(kinds).toContain('number');
    expect(kinds).toContain('literal');
    expect(kinds).toContain('punct');
    // 键与字符串值同形（带引号），必须靠"后随冒号"区分——不能都算 string
    const keyTexts = tokens.filter((tk) => tk.kind === 'key').map((tk) => tk.text);
    expect(keyTexts).toEqual(['"k"', '"n"', '"b"', '"z"']);
    const stringTexts = tokens.filter((tk) => tk.kind === 'string').map((tk) => tk.text);
    expect(stringTexts).toEqual(['"v"']);
    // 数字整体成块（负号/小数/指数不拆散）
    expect(tokens.filter((tk) => tk.kind === 'number').map((tk) => tk.text)).toEqual(['-1.5e3']);
    expect(tokens.filter((tk) => tk.kind === 'literal').map((tk) => tk.text)).toEqual([
      'true',
      'null',
    ]);
  });

  it('拼接保真：任意输入（含非法/截断文本）token 拼回 === 原串', () => {
    const samples = [
      '{"a":1,"b":[true,false,null]}',
      '{"unterminated":"value',
      'nonsense }{ 12 "x',
      '{"nested":{"deep":{"x":"}"}}}',
      '',
    ];
    for (const s of samples) expect(join(tokenizeJson(s))).toBe(s);
  });

  it('token 数封顶：超长数组不制造海量 DOM 节点', () => {
    const arr = JSON.stringify(Array.from({ length: 3000 }, (_, i) => i));
    const tokens = tokenizeJson(arr);
    expect(tokens.length).toBeLessThanOrEqual(JSON_TOKEN_MAX + 1);
    // 封顶后文本仍完整（尾部合并为 plain token，不丢字符）
    expect(join(tokens)).toBe(arr);
  });
});

describe('jsonLineTokens：行内单行着色（窗口化安全）', () => {
  it('前缀/载荷/后缀完整保留，拼接 === 原文行', () => {
    const line = '2026-09-06 10:00:01 [ERROR] {"code":"E1","retry":2} -- end';
    const tokens = jsonLineTokens(line)!;
    expect(tokens).toBeTruthy();
    expect(join(tokens)).toBe(line);
    // 前缀与后缀是 plain 档
    expect(tokens[0]).toEqual({ text: '2026-09-06 10:00:01 [ERROR] ', kind: 'plain' });
    expect(tokens[tokens.length - 1]).toEqual({ text: ' -- end', kind: 'plain' });
    // 载荷内部有键/数字档
    expect(tokens.some((tk) => tk.kind === 'key')).toBe(true);
    expect(tokens.some((tk) => tk.kind === 'number')).toBe(true);
  });

  it('★ 窗口化前提：任何 JSON 行的着色结果都不含换行符', () => {
    // 值里带真实换行（JSON 字符串里的 \n 转义在 JSON.parse 后是换行字符）
    const line = '[INFO] {"trace":"line1\\nline2","n":1}';
    const tokens = jsonLineTokens(line)!;
    expect(tokens).toBeTruthy();
    // 原文里的 \\n 是两个字符（反斜杠 + n），不是换行；断言确实没有真实 \n
    for (const tk of tokens) expect(tk.text).not.toContain('\n');
    expect(join(tokens)).toBe(line);
  });

  it('非 JSON 行 → null（调用方回落纯文本）', () => {
    expect(jsonLineTokens('plain log line')).toBeNull();
    expect(jsonLineTokens('')).toBeNull();
    expect(jsonLineTokens(null)).toBeNull();
    expect(jsonLineTokens(undefined)).toBeNull();
  });

  it('超长载荷截断为压缩形态并加省略号（仍单行、仍可着色）', () => {
    const line = `[INFO] {"blob":"${'y'.repeat(JSON_INLINE_MAX_CHARS + 500)}"}`;
    const tokens = jsonLineTokens(line)!;
    expect(tokens).toBeTruthy();
    const text = join(tokens);
    expect(text.length).toBeLessThan(line.length);
    expect(text.endsWith('…')).toBe(true);
    expect(text.startsWith('[INFO] ')).toBe(true);
    for (const tk of tokens) expect(tk.text).not.toContain('\n');
  });

  it('健壮性：循环结构 / BigInt / getter 抛错都不抛（回落 null）', () => {
    // 这些形态不可能从 JSON.parse 产生，但 formatJsonValue 是对外导出的纯函数，
    // 直接喂构造对象也必须安全（需求：循环结构 → 回落原始文本，绝不抛错）。
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => formatJsonValue(cyclic)).not.toThrow();
    expect(formatJsonValue(cyclic)?.inline).toBe('{"a":1,"self":"[Circular]"}');

    const withBigInt = { n: BigInt(10) };
    expect(() => formatJsonValue(withBigInt)).not.toThrow();
    expect(formatJsonValue(withBigInt)).toBeNull(); // JSON.stringify 抛 TypeError → null

    const throwing = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => formatJsonValue(throwing)).not.toThrow();
    expect(formatJsonValue(throwing)).toBeNull();
  });
});

describe('formatJsonValue：压缩 + 美化双形态', () => {
  it('压缩形态单行、美化形态缩进两格', () => {
    const out = formatJsonValue({ a: 1, b: [1, 2] })!;
    expect(out.inline).toBe('{"a":1,"b":[1,2]}');
    expect(out.pretty).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(out.truncated).toBe(false);
    expect(out.inline).not.toContain('\n');
  });

  it('超过 inlineMax / prettyMax 时截断并置 truncated', () => {
    const big = { blob: 'z'.repeat(200) };
    const tight = formatJsonValue(big, { inlineMax: 20, prettyMax: 30 })!;
    expect(tight.truncated).toBe(true);
    expect(tight.inline.endsWith('…')).toBe(true);
    expect(tight.inline.length).toBe(21);
    expect(tight.pretty.endsWith('\n…')).toBe(true);
    // 上限足够时不截断
    const loose = formatJsonValue(big, { inlineMax: 10_000, prettyMax: 10_000 })!;
    expect(loose.truncated).toBe(false);
  });
});

describe('prettyJsonForLine：浮层美化形态', () => {
  it('给出缩进 JSON，前缀/后缀不进入美化体', () => {
    const out = prettyJsonForLine('[WARN] {"a":1,"b":2}')!;
    expect(out.pretty).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(out.truncated).toBe(false);
  });

  it('非 JSON 行 → null', () => {
    expect(prettyJsonForLine('just text')).toBeNull();
    expect(prettyJsonForLine(null)).toBeNull();
  });

  it('超长载荷按上限截断，truncated 反映「任一形态超限」', () => {
    // 该行超过 JSON_PAYLOAD_MAX_CHARS → 连载荷都不定位，直接 null（防解析卡顿）
    expect(prettyJsonForLine(`{"blob":"${'q'.repeat(10_000)}"}`)).toBeNull();

    // 行内形态超限（>JSON_INLINE_MAX_CHARS）而美化形态未超限：
    // truncated=true（压缩形态会被截断），pretty 本身仍完整（无省略号）——
    // 两个上限互相独立，浮层不该因为行内截断而丢内容。
    const inlineBound = `{"blob":"${'q'.repeat(2500)}"}`;
    const out = prettyJsonForLine(inlineBound)!;
    expect(out.truncated).toBe(true);
    expect(out.pretty.endsWith('…')).toBe(false);

    // 美化形态超限（>JSON_PRETTY_MAX_CHARS）时追加换行省略号。受
    // JSON_PAYLOAD_MAX_CHARS 约束，深层嵌套是唯一能在 4KB 内把缩进形态
    // 撑过 6KB 的形态（每层多一份缩进）。
    const deep = '['.repeat(1500) + ']'.repeat(1500);
    expect(deep.length).toBeLessThan(JSON_PAYLOAD_MAX_CHARS);
    const out2 = prettyJsonForLine(deep)!;
    expect(out2.truncated).toBe(true);
    expect(out2.pretty.endsWith('\n…')).toBe(true);
  });
});
