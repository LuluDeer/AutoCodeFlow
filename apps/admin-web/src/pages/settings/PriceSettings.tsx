/**
 * N20 成本线 P1：管理设置页「价目表」Tab。
 *
 * 后端 CRUD 只暴露 GET / PUT（PUT 即 upsert，按 provider/model/direction 覆盖），
 * 没有 DELETE 路由——本页刻意只做「列出 + 新增/覆盖」，不提供删除入口。
 *
 * 诚实标注：价目本身不等于金额。没有 token 样本时成本看板仍显示「未折算」，
 * 这是数据状态而非价目缺失；表格上方始终呈现这条说明，避免管理员配完价目
 * 误以为看板该立刻出金额。
 */
import { useState, type HTMLAttributes } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { DollarOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ColumnsType } from 'antd/es/table';
import {
  listPrices,
  setPrice,
  type PricingConfig,
  type SetPriceDto,
} from '../../api/capability-activation';
import { showApiError } from '../../utils/error';
import { message } from '../../utils/toast';
import StateError from '../../components/StateError';
// MODAL-01 同源：本页只用 <Modal> JSX，命令式确认框不在此出现。
// i18n 实例在树内由 useTranslation 读取；显式导入确保单测直渲时词表已装载。
import '../../i18n';

/** 读键与写后失效键共用同一常量，避免两处手拼字符串漂移。 */
const PRICE_QUERY_KEY = ['capability-prices'] as const;

export default function PriceSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);

  // 读失败必须停在错误态：默认 data=[] 只用于「确实查到 0 条」，不能把失败伪装成空价目表。
  const { data: prices = [], isLoading, error, refetch } = useQuery({
    queryKey: PRICE_QUERY_KEY,
    queryFn: ({ signal }) => listPrices(signal),
  });

  const saveMut = useMutation({
    mutationFn: (dto: SetPriceDto) => setPrice(dto),
    onSuccess: () => {
      message.success(t('priceSettings.saved'));
      void qc.invalidateQueries({ queryKey: PRICE_QUERY_KEY });
    },
    // 失败保持弹窗打开、表单内容不丢；后端 message 由 showApiError 透出。
    onError: (err: unknown) => {
      showApiError(err, t('priceSettings.saveFail'));
    },
  });

  const close = () => {
    setOpen(false);
    form.resetFields();
  };

  const handleFinish = (values: SetPriceDto) => {
    saveMut.mutate(values, {
      onSuccess: () => close(),
    });
  };

  const columns: ColumnsType<PricingConfig> = [
    {
      title: t('priceSettings.col.provider'),
      dataIndex: 'provider',
      key: 'provider',
      width: 180,
      ellipsis: true,
    },
    {
      title: t('priceSettings.col.model'),
      dataIndex: 'model',
      key: 'model',
      width: 180,
      ellipsis: true,
    },
    {
      title: t('priceSettings.col.direction'),
      dataIndex: 'direction',
      key: 'direction',
      width: 110,
      render: (v: PricingConfig['direction']) => (
        <Tag color={v === 'in' ? 'blue' : 'green'}>
          {v === 'in' ? t('priceSettings.direction.in') : t('priceSettings.direction.out')}
        </Tag>
      ),
    },
    {
      title: t('priceSettings.col.pricePerMillionTokens'),
      dataIndex: 'pricePerMillionTokens',
      key: 'pricePerMillionTokens',
      width: 190,
      render: (v: number) => v,
    },
    {
      title: t('priceSettings.col.currency'),
      dataIndex: 'currency',
      key: 'currency',
      width: 110,
    },
  ];

  return (
    <div data-testid="price-settings">
      <Card
        title={
          <Space>
            <DollarOutlined aria-hidden />
            {t('priceSettings.title')}
          </Space>
        }
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined aria-hidden />}
            onClick={() => setOpen(true)}
            data-testid="price-add-btn"
          >
            {t('priceSettings.add')}
          </Button>
        }
      >
        {/* 诚实标注必须常驻（读失败时也显示）：价目 ≠ 金额，零 token 样本时看板仍标缺。 */}
        <Alert
          type="info"
          showIcon
          title={t('priceSettings.honestNote')}
          style={{ marginBottom: 16 }}
        />
        {error ? (
          <StateError
            error={error}
            title={t('priceSettings.loadFail')}
            onRetry={() => {
              void refetch();
            }}
          />
        ) : (
          <Table<PricingConfig>
            rowKey={(row) => `${row.provider}/${row.model}/${row.direction}`}
            size="small"
            columns={columns}
            dataSource={prices}
            loading={isLoading}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 770 }}
            locale={{ emptyText: <Empty description={t('priceSettings.empty')} /> }}
            // antd v6 的 onRow 类型只列 HTMLAttributes，data-* 是运行时合法属性——
            // 断言到 HTMLAttributes 以便把验收依赖的 testid 透传到 <tr>。
            onRow={() => ({ 'data-testid': 'price-row' } as unknown as HTMLAttributes<HTMLTableRowElement>)}
            data-testid="price-table"
          />
        )}
      </Card>

      <Modal
        open={open}
        title={t('priceSettings.modalTitle')}
        okText={t('priceSettings.ok')}
        cancelText={t('priceSettings.cancel')}
        confirmLoading={saveMut.isPending}
        onCancel={close}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          data-testid="price-form"
          initialValues={{ direction: 'in', currency: 'CNY' }}
          onFinish={handleFinish}
        >
          <Form.Item
            name="provider"
            label={t('priceSettings.field.provider')}
            rules={[
              { required: true, whitespace: true, message: t('priceSettings.field.providerRequired') },
              { max: 128, message: t('priceSettings.field.tooLong') },
            ]}
          >
            <Input placeholder={t('priceSettings.field.providerPlaceholder')} />
          </Form.Item>
          <Form.Item
            name="model"
            label={t('priceSettings.field.model')}
            rules={[
              { required: true, whitespace: true, message: t('priceSettings.field.modelRequired') },
              { max: 128, message: t('priceSettings.field.tooLong') },
            ]}
          >
            <Input placeholder={t('priceSettings.field.modelPlaceholder')} />
          </Form.Item>
          <Form.Item
            name="direction"
            label={t('priceSettings.field.direction')}
            rules={[{ required: true, message: t('priceSettings.field.directionRequired') }]}
          >
            <Select
              options={[
                { value: 'in', label: t('priceSettings.direction.in') },
                { value: 'out', label: t('priceSettings.direction.out') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="pricePerMillionTokens"
            label={t('priceSettings.field.pricePerMillionTokens')}
            rules={[
              {
                validator: (_rule, value: unknown) =>
                  typeof value === 'number' && Number.isFinite(value) && value > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('priceSettings.field.priceInvalid'))),
              },
            ]}
          >
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder={t('priceSettings.field.pricePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="currency"
            label={t('priceSettings.field.currency')}
            rules={[
              { required: true, message: t('priceSettings.field.currencyRequired') },
              { pattern: /^[A-Za-z]{3}$/, message: t('priceSettings.field.currencyInvalid') },
            ]}
          >
            <Input placeholder={t('priceSettings.field.currencyPlaceholder')} maxLength={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
