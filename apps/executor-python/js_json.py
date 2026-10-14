"""A-11R：与 JavaScript `JSON.stringify` **逐字节一致**的序列化器。

## 为什么必须有这个模块

A-11（2026-10-02）把两端 params→env 的口径统一成「JSON 序列化」，理由是
node 的 `String(v)` 与 python 的 `str(v)` 对布尔/空值/容器产出不同字节
（`true` vs `True`、`null` vs `None`、`["a"]` vs `['a']`）。方向正确，但落地上
有两处没做到，且都造成了**生产可见的回归**：

1. **字符串也被一起序列化**。中台 `ParamsEditor` 的契约是
   `Record<string, string>`——界面上配的每一个参数都是字符串，于是在 A-11
   之后**所有**经中台 UI 配置的参数都多了一对首尾双引号
   （`{"region":"欧盟"}` → `AUTOFLOW_REGION='\"欧盟\"'`）。按官方文档
   `int(os.environ.get("AUTOFLOW_LIMIT"))` 裸读的存量脚本直接
   `ValueError: invalid literal for int() with base 10: '"3"'`。
   生产实证：`tk-ship-notify` 因此静默停摆 12 天（10-02~10-14）。
2. **声称的「两端逐字节一致」并未做到**。契约向量只有 10 条、恰好不含临界
   形态，而 `JSON.stringify` 与 `json.dumps` 对浮点的指数/定点选择规则**不同**：

       wire 值      node JSON.stringify   python json.dumps
       1e-7         "1e-7"               "1e-07"        ← 指数补零 + 阈值不同
       1e-8         "1e-8"               "1e-08"
       0.00001      "0.00001"            "1e-05"

   同一份 `params` 在两个执行器上仍然注入不同的字节——A-11 修掉了「布尔/
   空值/容器」那一半真缺口，却在**用户不可见的地方**留下另一半。

## 本模块的职责

实现 ECMAScript 的 `Number::toString(x, 10)`（ECMA-262 §6.1.6.1.20）与
`JSON.stringify` 的容器/字面量规则，使 python 侧产出的字节与 node 侧的
`JSON.stringify` **完全相同**。这样「两端逐字节一致」才从注释里的一句话变成
可以由契约向量逐条断言的事实。

## 数值的两条规则（差异的全部来源）

- **定点 vs 指数**：JS 只在指数 `n` 满足 `n > 21` 或 `n <= -6` 时用指数记法
  （`n` 是小数点的位置，见 ECMA-262 的定义）；python 的 `repr` 阈值是
  `>= 16` / `< -4`。两者对 `1e-7` 与 `0.00001` 的结论因此相反。
- **指数不补零**：JS 写 `1e-7`，python 写 `1e-07`。
  另外 JS 的指数恒带符号（`1e+21`），python 的 `repr` 也带（`1e+21`）——这一
  条恰好一致，但不能依赖，故本模块自行拼装。

两者都靠「先取最短往返十进制数字（`repr` 的强项，与 JS 同为 shortest
round-trip），再按 JS 的规则重新排版」来消除。

## 大整数（超出 IEEE-754 双精度安全整数区）

node 的 `JSON.parse` 会把 `12345678901234567890` 读成**最近的 double**，随后
`JSON.stringify` 输出的是那个 double 的最短表示；python 的 `json.loads` 却给出
**精确**的 int。直接 `str(v)` 会让两端漂移。故 `abs(v) > 2**53` 的整数按
`float(v)` 走同一套 double 排版——刻意复刻「node 已经丢过精度」这一事实，
而不是复刻 python 的精确性。
"""

from typing import Any

__all__ = ['js_json_dumps', 'js_number_to_string', 'MAX_SAFE_INTEGER']

# IEEE-754 双精度可精确表示的最大连续整数（2**53）。JS 的
# Number.MAX_SAFE_INTEGER 是 2**53 - 1，但 2**53 本身仍可精确表示，故上界取
# 闭区间 ±2**53：node 侧 JSON.parse("9007199254740992") 得到精确值，
# JSON.stringify 也回 "9007199254740992"，与 str(v) 一致。
MAX_SAFE_INTEGER = 2 ** 53


def js_number_to_string(value: float) -> str:
    """ECMAScript `Number::toString(value, 10)` 的最小完整实现。

    只接受 float（int 请先经 ``_int_to_string`` 归一，以复刻 node 的
    JSON.parse 精度语义）。返回不含引号的字面量文本——`NaN` / `±Infinity`
    按 `JSON.stringify` 的规则收敛为 ``null``。
    """
    # JSON.stringify(NaN) / JSON.stringify(Infinity) 都是 "null"（不是
    # "NaN"/"Infinity"——那会让结果不是合法 JSON）。
    if value != value or value == float('inf') or value == float('-inf'):
        return 'null'
    # +0 与 -0 在 JS 里都串化成 "0"（Number::toString 的特例）。
    if value == 0:
        return '0'

    sign = '-' if value < 0 else ''
    x = -value if value < 0 else value

    # repr(float) 给出**最短往返**十进制表示（与 JS 的算法同为 shortest
    # round-trip，故数字本身一致），差异只在排版，下面全部重排。
    text = repr(x)
    if 'e' in text:
        mantissa, _, exponent_text = text.partition('e')
        exponent = int(exponent_text)
    else:
        mantissa, exponent = text, 0

    integer_part, _, fraction_part = mantissa.partition('.')
    # 前导零只是排版噪声，不改变数值：int("01") == int("1")。故 lstrip 后
    # digits 与原始数字串**数值相同**，不需要为剥掉的前导零做任何补偿
    # （曾误加 leading_zeros 补偿，令 0.1 → "1"、1/3 → "3.333…"，见探针）。
    digits = (integer_part + fraction_part).lstrip('0')
    if not digits:  # pragma: no cover - value==0 已在上方返回
        return sign + '0'

    # value == int(digits) * 10 ** (exponent - len(fraction_part))
    # 记 k = len(digits)、n 为小数点位置，则 value == s * 10 ** (n - k)。
    k = len(digits)
    n = k + exponent - len(fraction_part)

    # 去掉尾随零：k 减小、n 不变（n 是小数点位置，与尾零无关）。
    # 没有这一步，"100.0" 会串成 "1000" 而不是 "100"。
    digits = digits.rstrip('0') or '0'
    k = len(digits)

    if k <= n <= 21:
        # 整数形态：数字后补 (n-k) 个零。
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        # 小数点在数字中间。
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        # 0.00…digits（前导零个数 = -n）。
        return sign + '0.' + '0' * (-n) + digits

    # 指数形态：JS 的指数不补零，且恒带符号。
    power = n - 1
    exponent_sign = '+' if power >= 0 else '-'
    exponent_digits = abs(power)
    if k == 1:
        return f'{sign}{digits}e{exponent_sign}{exponent_digits}'
    return f'{sign}{digits[0]}.{digits[1:]}e{exponent_sign}{exponent_digits}'


def _int_to_string(value: int) -> str:
    """整数字面量：安全整数区内原样，区外复刻 node 的 double 精度。"""
    if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
        return str(value)
    # 超出安全整数区：node 的 JSON.parse 早已把它读成最近的 double，
    # JSON.stringify 输出的是那个 double。这里必须**同样地丢一次精度**，
    # 否则两端在同一份载荷上得到不同字节（python 精确、node 已舍入）。
    return js_number_to_string(float(value))


def _string_to_json(value: str) -> str:
    """字符串字面量：与 `JSON.stringify` 同形的转义。

    直接用 stdlib 的 json.dumps(ensure_ascii=False) 即可逐字节一致：
    两者都只转义 ``"`` ``\\`` 与 C0 控制字符（``\\b \\f \\n \\r \\t`` 用短形，
    其余 ``\\u00xx`` 小写十六进制），都不转义 DEL、都不转义非 ASCII
    （`ensure_ascii=False` 对应 JS 的原样 UTF-8 输出）。
    """
    import json

    return json.dumps(value, ensure_ascii=False)


def _array_index(key: str) -> int | None:
    """若 key 是 JS 语义下的「数组索引」，返回其数值，否则 None。

    判据（ECMA-262 §6.1.7 Property Key / Array Index）：key 是 ``0`` 到
    ``2**32 - 2`` 之间整数、且**十进制字符串就是它本身**（无前导零、无正负号、
    无小数点、无指数）。故 ``"0"``/``"10"`` 是，``"01"``/``"1.5"``/``"-1"``/
    ``"4294967295"``（= 2**32-1，超出上界）都不是。
    """
    if not key or not key.isdigit():
        return None
    # isdigit() 对全角数字等也返回 True，故再确认是纯 ASCII 数字。
    if not key.isascii():
        return None
    # 前导零（"01"、"00"）不是规范形态——JS 不把它们当数组索引。
    if len(key) > 1 and key[0] == '0':
        return None
    value = int(key)
    return value if value < 2 ** 32 - 1 else None


def _ordered_keys(mapping: dict) -> list:
    """按 `JSON.stringify` 的 'OwnPropertyKeys' 顺序重排对象键。

    JS 的对象键顺序**不是**纯插入序：整数索引键先按**数值升序**全部排在前面，
    其余键再按插入序跟随。python 的 dict 恒为插入序，故两端在同一份载荷上会
    产出不同字节——实测 ``{"b":1,"0":2}`` node 给 ``{"0":2,"b":1}``、python 给
    ``{"b":1,"0":2}``。这类键在真实 params 里并不罕见（用户常写 ``{"0": ...,
    "1": ...}`` 这类序号参数），且嵌套容器同样受影响，故必须复刻。

    稳定性：非索引键保持插入序（sorted 是稳定的，但这里显式分组以免依赖
    "索引键恰好都小于非索引键"这种巧合）。
    """
    indexed: list = []
    rest: list = []
    for key in mapping.keys():
        text = key if isinstance(key, str) else str(key)
        position = _array_index(text)
        if position is None:
            rest.append((text, key))
        else:
            indexed.append((position, text, key))
    indexed.sort(key=lambda item: item[0])
    return [key for _, _, key in indexed] + [key for _, key in rest]


def js_json_dumps(value: Any) -> str:
    """`JSON.stringify(value)` 的同字节实现（紧凑、无空格、JS 键序）。

    刻意不使用 ``json.dumps`` 的整体实现：它的浮点排版与键序都与
    `JSON.stringify` 不一致，而那正是本模块存在的原因。容器递归下降，标量走
    上面的专用排版。

    ``undefined`` 在 python 里没有对应物；``dict`` 中值为 ``None`` 的键按
    JSON 规则保留为 ``null``（python 侧不存在「值为 undefined 的键」这一
    形态，故不需要复刻 JSON.stringify 丢弃这类键的行为）。
    """
    if value is None:
        return 'null'
    # bool 必须在 int 之前判——python 的 bool 是 int 的子类，顺序颠倒会把
    # True 串成 "1"（正是 A-11 要修的那个 str(v) 缺陷的变体）。
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, int):
        return _int_to_string(value)
    if isinstance(value, float):
        return js_number_to_string(value)
    if isinstance(value, str):
        return _string_to_json(value)
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(js_json_dumps(item) for item in value) + ']'
    if isinstance(value, dict):
        parts = []
        for key in _ordered_keys(value):
            # JSON 对象键恒为字符串（json.loads 保证），非 str 键按 JS 的
            # ToString 语义兜底，绝不抛错——一个畸形键不该让任务跑不起来。
            key_text = key if isinstance(key, str) else str(key)
            parts.append(_string_to_json(key_text) + ':' + js_json_dumps(value[key]))
        return '{' + ','.join(parts) + '}'
    # 兜底：不可 JSON 化的类型（datetime 等）走 str()，与 node 侧
    # JSON.stringify 对不可序列化值抛错的姿态不同——此处选择"尽力注入"，
    # 因为让整个任务因一个参数类型失败远比注入一个字符串表示更糟。
    return _string_to_json(str(value))
