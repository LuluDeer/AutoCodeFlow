import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Typography, Tooltip, theme } from 'antd';
import { PlusOutlined, DeleteOutlined, InfoCircleOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

/** 后端读路径对所有 secret 叶子值返回的字面量（SEC-02）。 */
export const SECRET_MASK = '******';

interface SecretRow {
  key: string;
  value: string;
  /** 该行来自服务端（值只显示掩码，真实值不可回读）。 */
  existing: boolean;
  /**
   * 该行在服务端原来的键名（仅既有行为真）。用户改键名时，行本身不再是"原来的
   * 那个键"——必须在载荷里把原键显式发 null，否则后端合并语义会**保留旧凭据**，
   * 于是"改个名字"变成"多留下一把仍然有效的凭据"，这在凭据面是安全问题。
   */
  originalKey?: string;
}

interface SecretsEditorProps {
  value?: SecretsPatchValue | null;
  /** `undefined` = 用户没动过（调用方省略键）；`null` = 清空全部。 */
  onChange?: (val: SecretsPatchValue | null | undefined) => void;
  /**
   * 服务端已有的凭据（读路径返回的掩码映射）。用于**显示**既有键——用户必须
   * 看得见"这台任务已经配了 FEISHU_APP_ID"，否则会以为平台没生效而重复配置。
   * 它刻意**不**进表单值：表单值是"本次要写什么"，已有凭据由后端按合并语义保留。
   */
  existing?: Record<string, string> | null;
}

/**
 * 外发形态：值是凭据明文；`null` = 显式删除该键；`null`（整体）= 清空全部。
 * 与后端 PATCH 的逐键合并契约一一对应（见 admin-api 的 mergeSecretsOnUpdate）。
 */
export type SecretsPatchValue = Record<string, string | null>;

/**
 * SEC-02 续（生产故障）：任务级凭据编辑器。
 *
 * ## 为什么必须存在
 *
 * 此前控制台**完全没有** secrets 入口，而执行器的报错文案却在教用户
 * 「请在平台 secrets 配置 FEISHU_APP_ID」——一条**在 UI 上无法执行**的指令。
 * 生产实证：用户按提示配不出凭据，任务报「缺少飞书凭证」。
 *
 * ## 外发语义（与后端 PATCH 的逐键合并契约一一对应）
 *
 * 后端读路径对所有叶子回字面量 `******`，写路径按**逐键合并**处理
 * （见 admin-api 的 mergeSecretsOnUpdate），于是本组件只需表达"改了什么"：
 *   · 用户没动任何行 → `onChange(undefined)`，调用方**整体省略** secrets 键
 *     → 后端一个键都不碰（这是最常见的路径：改个超时、改个名字，凭据不受影响）；
 *   · 掩码行（既有键）未重新输入 → **不出现在外发对象里** → 后端保留该键原值；
 *   · 用户填了值的行 → 出现在外发对象里 → 后端加密覆盖；
 *   · 用户删掉一个既有键 → 该键外发 `null` → 后端**删除**它
 *     （合并语义下"键缺省"是保留，删除必须显式表达，否则删不掉）；
 *   · 点「清空全部」→ 外发 `null`（整体清空信号）。
 *
 * 关键红线：**掩码值永不外发**。既有的整体替换语义下这会不可逆销毁真实凭据，
 * 合并语义下会退化成 no-op，两种都不该发生——所以外发对象里根本不含掩码。
 *
 * 与 ParamsEditor 的 F-02 半受控修复同款「最后外发值」ref 模式：外部注入能
 * 同步进 rows，自身输入回流不重置行（避免光标跳动与更新循环）。
 */
export default function SecretsEditor({ value, onChange, existing }: SecretsEditorProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  /**
   * 既有键（掩码）+ 本次已填键合并成行。既有键在前，顺序稳定便于对账。
   */
  const buildRows = (
    v?: SecretsPatchValue | null,
    ex?: Record<string, string> | null,
  ): SecretRow[] => {
    const rows: SecretRow[] = [];
    const seen = new Set<string>();
    for (const [key, val] of Object.entries(ex ?? {})) {
      rows.push({ key, value: val, existing: true, originalKey: key });
      seen.add(key);
    }
    for (const [key, val] of Object.entries(v ?? {})) {
      // null 叶子 = 显式删除该键：不在界面上显示为一行。
      if (val === null) continue;
      const idx = rows.findIndex(r => r.key === key && r.existing);
      if (idx >= 0) {
        // 用户重新输入了既有键：该行转为普通行（值不再是掩码）。
        rows[idx] = { key, value: String(val), existing: false, originalKey: rows[idx].originalKey };
      } else if (!seen.has(key)) {
        rows.push({ key, value: String(val), existing: false });
      }
    }
    return rows;
  };

  const [rows, setRows] = useState<SecretRow[]>(() => buildRows(value, existing));
  const lastEmittedRef = useRef<SecretsPatchValue | null | undefined>(undefined);
  /** 用户是否动过任意一行——决定外发"本次变更"还是"省略键"。 */
  const [touched, setTouched] = useState(false);
  const touchedRef = useRef(false);

  const isEcho = (
    a?: SecretsPatchValue | null,
    b?: SecretsPatchValue | null,
  ) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  useEffect(() => {
    if (!isEcho(value, lastEmittedRef.current)) {
      setRows(buildRows(value, existing));
      // 外部整体替换（切换编辑对象/重置表单）后，触碰状态随之归零——
      // 否则新建任务时会因为上一次编辑的残留 touched 而误发空对象。
      setTouched(false);
      touchedRef.current = false;
    }

  }, [value, existing]);

  /**
   * 外发。只表达"本次变更"：既有键未重新输入 → 该键缺省（后端保留）；
   * 删掉既有键 → 显式 null（后端删除）；填了值 → 原值。
   * `touched === false` 时发 undefined（调用方省略键），后端一个键都不碰。
   */
  const emit = (updated: SecretRow[], isTouched: boolean) => {
    if (!isTouched) {
      lastEmittedRef.current = undefined;
      onChange?.(undefined);
      return;
    }
    const result: SecretsPatchValue = {};
    for (const r of updated) {
      const k = r.key.trim();
      // 原键已被改名/删除 → 显式发 null 让后端删掉它（合并语义下"键缺省"是保留）。
      if (r.originalKey && r.originalKey !== k) result[r.originalKey] = null;
      if (!k) continue;
      if (r.value === SECRET_MASK) continue; // 既有键未重新输入 → 缺省 = 保留
      // 既有键但值为空 → 用户清空了它，语义是"删除"（已由上面的 originalKey 表达）。
      if (r.existing && r.value === '') {
        result[k] = null;
        continue;
      }
      result[k] = r.value;
    }
    // 整行被删掉的既有键：行已不在 updated 里，用原键反查补 null。
    for (const r of rows) {
      if (!r.originalKey) continue;
      if (!updated.some(u => u.originalKey === r.originalKey)) {
        result[r.originalKey] = null;
      }
    }
    lastEmittedRef.current = result;
    onChange?.(result);
  };

  const markTouched = () => {
    if (!touchedRef.current) {
      touchedRef.current = true;
      setTouched(true);
    }
  };

  const update = (idx: number, field: 'key' | 'value', val: string) => {
    markTouched();
    // 改键名时保留 originalKey：原键要在载荷里显式删掉（见 SecretRow.originalKey）。
    const next = rows.map((r, i) =>
      i === idx
        ? field === 'key'
          ? { ...r, key: val }
          : { ...r, value: val, existing: val === SECRET_MASK }
        : r,
    );
    setRows(next);
    emit(next, true);
  };

  const add = () => {
    markTouched();
    const next = [...rows, { key: '', value: '', existing: false }];
    setRows(next);
    emit(next, true);
  };

  const remove = (idx: number) => {
    markTouched();
    const next = rows.filter((_, i) => i !== idx);
    setRows(next);
    emit(next, true);
  };

  /**
   * 清空全部凭据。外发 `null`（后端"整体清空"信号）——不是 `{}`：
   * 合并语义下空对象 = 一个键都不改，那样"清空"会静默失效。
   */
  const clearAll = () => {
    markTouched();
    setRows([]);
    lastEmittedRef.current = undefined;
    onChange?.(null);
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        icon={<LockOutlined />}
        title={t('secretsEditor.alertTitle')}
        description={t('secretsEditor.alertDesc')}
        style={{ marginBottom: 12 }}
      />
      {rows.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          {t('secretsEditor.empty')}
        </Text>
      )}
      {rows.map((row, idx) => {
        const masked = row.value === SECRET_MASK;
        return (
          <div
            key={idx}
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}
          >
            <Input
              placeholder={t('secretsEditor.keyPlaceholder')}
              value={row.key}
              onChange={e => update(idx, 'key', e.target.value)}
              style={{ width: 180, maxWidth: '100%', fontFamily: 'monospace' }}
            />
            <Text type="secondary">=</Text>
            {masked ? (
              // 掩码行：值输入框显示锁形占位而非 "******"，避免用户误以为
              // 那就是真实值；一旦开始输入即转为普通行。
              <Input.Password
                placeholder={t('secretsEditor.maskedPlaceholder')}
                value=""
                prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
                onChange={e => update(idx, 'value', e.target.value)}
                style={{ flex: '1 1 180px', minWidth: 0 }}
              />
            ) : (
              <Input.Password
                placeholder={t('secretsEditor.valuePlaceholder')}
                value={row.value}
                onChange={e => update(idx, 'value', e.target.value)}
                style={{ flex: '1 1 180px', minWidth: 0 }}
              />
            )}
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => remove(idx)}
              aria-label={t('secretsEditor.remove')}
            />
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={add}>
          {t('secretsEditor.add')}
        </Button>
        {rows.length > 0 && (
          <Button type="text" size="small" danger onClick={clearAll}>
            {t('secretsEditor.clearAll')}
          </Button>
        )}
        <Tooltip title={t('secretsEditor.tooltip')}>
          <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
        </Tooltip>
      </div>
      {touched && (
        <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          {t('secretsEditor.touchedWarning')}
        </Text>
      )}
    </div>
  );
}
