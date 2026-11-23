import { useEffect, useState } from 'react';
import { Form, Input, Modal } from 'antd';
import { useTranslation } from 'react-i18next';
// js-yaml 4.x 在本包没有随包类型（仅传递依赖）：下面一行只压掉类型噪声，
// 运行时由 Vite 打包；frontMatterJson → YAML 的序列化统一走 js-yaml。
// @ts-expect-error js-yaml 4.x lacks bundled types in admin-web
import { dump as yamlDump } from 'js-yaml';
import { sopsApi } from '../../api/sops';
import type { Sop } from '../../api/sops';
import { showApiError } from '../../utils/error';
import { message } from '../../utils/toast';

/** 与新建草稿弹窗的 id 分开：两个弹窗可同时挂载，id 必须唯一。 */
const EDIT_DRAFT_FIELD_ID = {
  title: 'sops-edit-draft-title',
  frontMatter: 'sops-edit-draft-front-matter',
  body: 'sops-edit-draft-body',
} as const;

interface DraftFormState {
  title: string;
  frontMatterYaml: string;
  bodyMarkdown: string;
}

export interface EditDraftModalProps {
  /** 非 null 即打开；SopsPage 只持有 target 与打开/关闭回调。 */
  target: Sop | null;
  onClose: () => void;
  /** 保存成功：把后端返回的 newest SOP 交回页面，由页面刷新详情与列表。 */
  onSaved: (updated: Sop) => void;
}

function frontMatterToYaml(value: Sop['frontMatterJson']): string {
  if (value === null) return '';
  try {
    return yamlDump(value, { noRefs: true, lineWidth: -1 }).trim();
  } catch {
    // 极端对象（循环引用等）回退到 JSON——JSON 本身是合法 YAML；连 JSON 也失败就留空。
    try { return JSON.stringify(value, null, 2); } catch { return ''; }
  }
}

/**
 * SOP 草稿内容编辑弹窗：预填 title / front-matter（YAML 文本）/ body，
 * 提交走既有的 `sopsApi.updateDraft`（PATCH /sop/:id）。仅工作副本（draft）
 * 可达；published/deprecated 的工作副本编辑是后续独立决策，不在本弹窗内。
 */
export default function EditDraftModal({ target, onClose, onSaved }: EditDraftModalProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DraftFormState>({ title: '', frontMatterYaml: '', bodyMarkdown: '' });
  const [saving, setSaving] = useState(false);

  // 每次打开按当前 target 重新预填，避免上一次编辑残留到别的 SOP。
  useEffect(() => {
    if (!target) return;
    setForm({
      title: target.title ?? '',
      frontMatterYaml: frontMatterToYaml(target.frontMatterJson),
      bodyMarkdown: target.bodyMarkdown ?? '',
    });
    setSaving(false);
  }, [target]);

  const submit = async () => {
    if (!target || saving) return;
    const title = form.title.trim();
    if (!title) {
      message.warning(t('sops.titleRequired'));
      return;
    }
    setSaving(true);
    try {
      // 空 YAML 不能发：后端 `!== undefined` 即 parse，空串会被判「front-matter 为空」→ 400。
      // 留空表示本字段不修改（与 SopsPage.createDraft 的 `|| undefined` 同口径）；
      // bodyMarkdown 保留空串语义——用户清空正文是一次显式编辑。
      const frontMatterYaml = form.frontMatterYaml.trim();
      const updated = await sopsApi.updateDraft(target.id, {
        title,
        frontMatterYaml: frontMatterYaml ? form.frontMatterYaml : undefined,
        bodyMarkdown: form.bodyMarkdown,
      });
      message.success(t('sops.editDraft.saved'));
      onSaved(updated);
    } catch (err: unknown) {
      // 失败不关弹窗：用户当场修正后重试，表单内容原样保留。
      showApiError(err, t('sops.editDraft.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('sops.editDraft.title', { slug: target?.slug ?? '' })}
      open={target !== null}
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('sops.create')}
      cancelText={t('sops.cancel')}
      okButtonProps={{ id: 'sops-edit-draft-save' }}
      width={720}
      destroyOnHidden
    >
      <Form layout="vertical" component={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Form.Item label={t('sops.field.draftTitle')} htmlFor={EDIT_DRAFT_FIELD_ID.title} style={{ marginBottom: 0 }}>
            <Input
              id={EDIT_DRAFT_FIELD_ID.title}
              value={form.title}
              maxLength={255}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('sops.field.draftFrontMatter')} htmlFor={EDIT_DRAFT_FIELD_ID.frontMatter} style={{ marginBottom: 0 }}>
            <Input.TextArea
              id={EDIT_DRAFT_FIELD_ID.frontMatter}
              rows={10}
              placeholder={t('sops.frontMatterPlaceholder')}
              value={form.frontMatterYaml}
              onChange={(e) => setForm({ ...form, frontMatterYaml: e.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('sops.field.draftBody')} htmlFor={EDIT_DRAFT_FIELD_ID.body} style={{ marginBottom: 0 }}>
            <Input.TextArea
              id={EDIT_DRAFT_FIELD_ID.body}
              rows={6}
              placeholder={t('sops.bodyPlaceholder')}
              value={form.bodyMarkdown}
              onChange={(e) => setForm({ ...form, bodyMarkdown: e.target.value })}
            />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
